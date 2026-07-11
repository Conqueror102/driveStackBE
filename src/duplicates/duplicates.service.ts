import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ActivityEventType, NotificationType } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';

type FileDuplicateCandidate = {
  id: string;
  name: string;
  sizeBytes: bigint;
  md5Checksum: string | null;
};

export type ResolveStrategy = 'keep_newest' | 'keep_oldest';

@Injectable()
export class DuplicatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly featureGuard: FeatureGuardService,
    private readonly files: FilesService,
  ) {}

  async list(userId: string) {
    const groups = await this.prisma.duplicateGroup.findMany({
      where: { userId },
      orderBy: [{ sizeBytes: 'desc' }, { name: 'asc' }],
    });
    const fileIds = groups.flatMap((group) => group.fileIds);
    const files = fileIds.length
      ? await this.prisma.fileCache.findMany({
          where: { id: { in: fileIds }, account: { userId } },
          include: {
            account: {
              select: {
                id: true,
                googleEmail: true,
                displayName: true,
                storageLimit: true,
                storageUsed: true,
                isDefault: true,
              },
            },
          },
        })
      : [];
    const filesById = new Map(files.map((file) => [file.id, file]));

    // Hydrate against live FileCache rows and drop copies that no longer exist
    // (e.g. trashed outside a resolve) so the summary can't overstate savings.
    const hydrated = groups
      .map((group) => ({
        ...group,
        files: group.fileIds.map((fileId) => filesById.get(fileId)).filter(Boolean),
      }))
      .filter((group) => group.files.length > 1);

    return {
      summary: this.summarizeGroups(
        hydrated.map((group) => ({
          fileIds: group.files.map((file) => file!.id),
          sizeBytes: group.sizeBytes,
          createdAt: group.createdAt,
        })),
      ),
      groups: hydrated,
    };
  }

  async count(userId: string) {
    const groups = await this.prisma.duplicateGroup.findMany({
      where: { userId },
      select: { fileIds: true, sizeBytes: true, createdAt: true },
    });
    return this.summarizeGroups(groups);
  }

  async triggerScan(userId: string) {
    await this.featureGuard.requireFeature(userId, 'duplicate_detector');
    const queued = await this.queue.enqueueDuplicateScan(userId);
    if (!queued) {
      const summary = await this.runDuplicateScanForUser(userId);
      return { queued: false, summary };
    }
    return { queued: true };
  }

  /**
   * Resolve a single duplicate group by keeping one file and trashing the rest.
   * Reuses FilesService.bulkDelete so Drive trashing, cache cleanup and quota
   * refresh all go through the existing, tested path.
   */
  async resolveGroup(userId: string, groupId: string, keepFileId: string) {
    await this.featureGuard.requireFeature(userId, 'duplicate_detector');
    const group = await this.prisma.duplicateGroup.findUnique({ where: { id: groupId } });
    if (!group || group.userId !== userId) {
      throw new NotFoundException('Duplicate group not found');
    }
    if (!group.fileIds.includes(keepFileId)) {
      throw new BadRequestException('keepFileId must be one of the files in the group');
    }
    const result = await this.trashDuplicates(userId, group, [keepFileId]);
    // The group is resolved — drop it so summaries reflect reality immediately
    // (a rescan is also queued by bulkDelete and will rebuild if anything remains).
    if (result.failed === 0) {
      await this.prisma.duplicateGroup.delete({ where: { id: group.id } }).catch(() => undefined);
    }
    return result;
  }

  /**
   * Resolve every duplicate group for a user using a keep strategy.
   */
  async resolveAll(userId: string, strategy: ResolveStrategy = 'keep_newest') {
    await this.featureGuard.requireFeature(userId, 'duplicate_detector');
    const groups = await this.prisma.duplicateGroup.findMany({ where: { userId } });
    let trashed = 0;
    let failed = 0;
    let reclaimedBytes = 0n;
    for (const group of groups) {
      const keepId = await this.pickKeeper(userId, group, strategy);
      if (!keepId) continue;
      const r = await this.trashDuplicates(userId, group, [keepId]);
      trashed += r.trashed;
      failed += r.failed;
      reclaimedBytes += r.reclaimedBytes;
      if (r.failed === 0) {
        await this.prisma.duplicateGroup.delete({ where: { id: group.id } }).catch(() => undefined);
      }
    }
    return { groupsResolved: groups.length, trashed, failed, reclaimedBytes };
  }

  private async trashDuplicates(
    userId: string,
    group: { fileIds: string[]; sizeBytes: bigint },
    keepIds: string[],
  ) {
    const files = await this.prisma.fileCache.findMany({
      where: { id: { in: group.fileIds }, account: { userId } },
      select: { id: true, driveFileId: true, accountId: true },
    });
    const toTrash = files.filter((file) => !keepIds.includes(file.id));
    if (toTrash.length === 0) {
      return { trashed: 0, failed: 0, reclaimedBytes: 0n };
    }
    const result = await this.files.bulkDelete(userId, {
      files: toTrash.map((file) => ({ accountId: file.accountId, driveFileId: file.driveFileId })),
    });
    // All copies in a group share the same size, so reclaimed = size * copies removed.
    const reclaimedBytes = group.sizeBytes * BigInt(result.success);
    return { trashed: result.success, failed: result.failed, reclaimedBytes };
  }

  private async pickKeeper(
    userId: string,
    group: { fileIds: string[] },
    strategy: ResolveStrategy,
  ): Promise<string | null> {
    const files = await this.prisma.fileCache.findMany({
      where: { id: { in: group.fileIds }, account: { userId } },
      select: { id: true, driveModifiedAt: true },
    });
    if (files.length <= 1) return null;
    const sorted = [...files].sort(
      (a, b) => a.driveModifiedAt.getTime() - b.driveModifiedAt.getTime(),
    );
    return strategy === 'keep_oldest' ? sorted[0].id : sorted[sorted.length - 1].id;
  }

  async runDuplicateScanForUser(userId: string) {
    const existingCount = await this.prisma.duplicateGroup.count({ where: { userId } });

    // Use cursor-based pagination to avoid loading all files into memory at once
    const BATCH_SIZE = 5000;
    const grouped = new Map<string, FileDuplicateCandidate[]>();
    let cursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await this.prisma.fileCache.findMany({
        where: {
          account: { userId },
          isFolder: false,
          sizeBytes: { gt: 0 },
        },
        select: {
          id: true,
          name: true,
          sizeBytes: true,
          md5Checksum: true,
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (batch.length === 0) break;

      for (const file of batch) {
        const key = file.md5Checksum
          ? `md5:${file.md5Checksum}`
          : `ns:${file.name}\u0000${file.sizeBytes.toString()}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.push(file);
        } else {
          grouped.set(key, [file]);
        }
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
    }

    const duplicates = [...grouped.values()]
      .filter((items) => items.length > 1)
      .sort((a, b) => {
        if (a[0].sizeBytes === b[0].sizeBytes) return a[0].name.localeCompare(b[0].name);
        return a[0].sizeBytes > b[0].sizeBytes ? -1 : 1;
      });

    await this.prisma.$transaction([
      this.prisma.duplicateGroup.deleteMany({ where: { userId } }),
      ...(duplicates.length
        ? [
            this.prisma.duplicateGroup.createMany({
              data: duplicates.map((items) => ({
                userId,
                name: items[0].name,
                sizeBytes: items[0].sizeBytes,
                fileIds: items.map((item) => item.id),
              })),
            }),
          ]
        : []),
    ]);

    const summary = this.summarizeGroups(
      duplicates.map((items) => ({
        fileIds: items.map((item) => item.id),
        sizeBytes: items[0].sizeBytes,
        createdAt: new Date(),
      })),
    );

    if (existingCount === 0 && summary.groups > 0) {
      await this.notifications.create(
        userId,
        NotificationType.DUPLICATE_FOUND,
        `${summary.groups} duplicate groups found across your accounts`,
      );
    }
    await this.activity.create({
      userId,
      type: ActivityEventType.DUPLICATE_SCAN_COMPLETED,
      message: `Duplicate scan completed: ${summary.groups} groups found`,
      metadata: {
        groups: summary.groups,
        duplicateFiles: summary.duplicateFiles,
        recoverableBytes: summary.recoverableBytes.toString(),
      },
    });

    return summary;
  }

  private summarizeGroups(groups: Array<{ fileIds: string[]; sizeBytes: bigint; createdAt?: Date }>) {
    const duplicateFiles = groups.reduce((sum, group) => sum + group.fileIds.length, 0);
    const recoverableBytes = groups.reduce((sum, group) => {
      const removableCopies = Math.max(group.fileIds.length - 1, 0);
      return sum + group.sizeBytes * BigInt(removableCopies);
    }, 0n);
    const lastScannedAt = groups.reduce<Date | null>((latest, group) => {
      if (!group.createdAt) return latest;
      if (!latest || group.createdAt > latest) return group.createdAt;
      return latest;
    }, null);

    return {
      groups: groups.length,
      duplicateFiles,
      recoverableBytes,
      lastScannedAt,
    };
  }
}
