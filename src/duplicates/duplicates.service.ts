import { Injectable } from '@nestjs/common';
import { ActivityEventType, NotificationType } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';

type FileDuplicateCandidate = {
  id: string;
  name: string;
  sizeBytes: bigint;
};

@Injectable()
export class DuplicatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly featureGuard: FeatureGuardService,
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

    return {
      summary: this.summarizeGroups(groups),
      groups: groups.map((group) => ({
        ...group,
        files: group.fileIds.map((fileId) => filesById.get(fileId)).filter(Boolean),
      })),
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

  async runDuplicateScanForUser(userId: string) {
    const existingCount = await this.prisma.duplicateGroup.count({ where: { userId } });
    const files = await this.prisma.fileCache.findMany({
      where: {
        account: { userId },
        isFolder: false,
        sizeBytes: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        sizeBytes: true,
      },
    });

    const grouped = new Map<string, FileDuplicateCandidate[]>();
    for (const file of files) {
      const key = `${file.name}\u0000${file.sizeBytes.toString()}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.push(file);
      } else {
        grouped.set(key, [file]);
      }
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
