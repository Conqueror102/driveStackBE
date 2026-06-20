import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityEventType, FileCache, FileType, MovePhase, MoveStatus, NotificationType } from '@prisma/client';
import { Readable, Transform, TransformCallback } from 'stream';
import { ActivityService } from '../activity/activity.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { DriveFile, DriveService } from '../drive/drive.service';
import { DuplicatesService } from '../duplicates/duplicates.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';
import { BulkMoveDto } from './dto/bulk-move.dto';
import { MoveFileDto } from './dto/move-file.dto';
import { MoveGateway } from './move.gateway';

type MoveOperationSnapshot = {
  id: string;
  userId: string;
  driveFileId: string;
  destinationDriveFileId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: bigint;
  sourceAccountId: string;
  destinationAccountId: string;
  status: MoveStatus;
  phase: MovePhase;
  bytesTransferred: bigint;
  totalBytes: bigint;
  progress: number;
  totalItems: number;
  completedItems: number;
  startedAt: Date | null;
};

type CreatedMoveFiles = {
  rootFile: DriveFile;
  createdFiles: DriveFile[];
  sourceDriveFileIds: string[];
};

@Injectable()
export class MoveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly driveService: DriveService,
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
    private readonly duplicates: DuplicatesService,
    private readonly configService: ConfigService,
    private readonly gateway: MoveGateway,
    private readonly activity: ActivityService,
    private readonly featureGuard: FeatureGuardService,
  ) {}

  async initiate(userId: string, dto: MoveFileDto) {
    await this.featureGuard.requireFeature(userId, 'move_files');
    if (dto.sourceAccountId === dto.destinationAccountId) {
      throw new BadRequestException('Destination account must be different from source account');
    }

    const [source, destination] = await Promise.all([
      this.prisma.connectedAccount.findFirst({ where: { id: dto.sourceAccountId, userId } }),
      this.prisma.connectedAccount.findFirst({ where: { id: dto.destinationAccountId, userId } }),
    ]);
    if (!source || !destination) {
      throw new ForbiddenException('Account does not belong to user');
    }

    const file = await this.prisma.fileCache.findUnique({
      where: { accountId_driveFileId: { accountId: dto.sourceAccountId, driveFileId: dto.driveFileId } },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }

    const totals = await this.getMoveTotals(dto.sourceAccountId, file);
    if (totals.totalBytes > destination.storageLimit - destination.storageUsed) {
      throw new BadRequestException('Not enough space in destination account');
    }

    const operation = await this.prisma.moveOperation.create({
      data: {
        userId,
        driveFileId: dto.driveFileId,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sourceAccountId: dto.sourceAccountId,
        destinationAccountId: dto.destinationAccountId,
        totalBytes: totals.totalBytes,
        totalItems: totals.totalItems,
      },
    });

    const queued = await this.queue.enqueueMoveFile(operation.id);
    if (!queued) {
      void this.processMove(operation.id, false);
    }

    return { operationId: operation.id, queued };
  }

  async getStatus(userId: string, operationId: string) {
    const operation = await this.prisma.moveOperation.findFirst({
      where: { id: operationId, userId },
    });
    if (!operation) {
      throw new NotFoundException('Move operation not found');
    }
    return operation;
  }

  async history(userId: string, page = 1, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const currentPage = Math.max(page, 1);
    const [total, data] = await this.prisma.$transaction([
      this.prisma.moveOperation.count({ where: { userId } }),
      this.prisma.moveOperation.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * take,
        take,
      }),
    ]);
    return {
      data,
      meta: {
        total,
        page: currentPage,
        limit: take,
        lastPage: Math.ceil(total / take),
      },
    };
  }

  async bulkMove(userId: string, dto: BulkMoveDto) {
    await this.featureGuard.requireFeature(userId, 'bulk_operations');
    const results: {
      success: number;
      failed: number;
      operations: Array<{ driveFileId: string; operationId: string; queued: boolean }>;
      errors: Array<{ driveFileId: string; message: string }>;
    } = { success: 0, failed: 0, operations: [], errors: [] };

    for (const file of dto.files) {
      try {
        const result = await this.initiate(userId, {
          driveFileId: file.driveFileId,
          sourceAccountId: file.sourceAccountId,
          destinationAccountId: dto.destinationAccountId,
        });
        results.success += 1;
        results.operations.push({ driveFileId: file.driveFileId, ...result });
      } catch (error) {
        results.failed += 1;
        results.errors.push({
          driveFileId: file.driveFileId,
          message: error instanceof Error ? error.message : 'Move failed',
        });
      }
    }

    return results;
  }

  async processMove(operationId: string, rethrow = false): Promise<void> {
    const operation = await this.prisma.moveOperation.findUnique({ where: { id: operationId } });
    if (!operation) {
      if (rethrow) throw new NotFoundException('Move operation not found');
      return;
    }
    if (operation.status === 'COMPLETED') {
      return;
    }

    try {
      const current = await this.updateMoveState(operationId, {
        status: 'IN_PROGRESS',
        phase: 'PREPARING',
        startedAt: operation.startedAt || new Date(),
        error: null,
      });

      const [source, destination] = await Promise.all([
        this.prisma.connectedAccount.findFirst({ where: { id: current.sourceAccountId, userId: current.userId } }),
        this.prisma.connectedAccount.findFirst({ where: { id: current.destinationAccountId, userId: current.userId } }),
      ]);
      if (!source || !destination) {
        throw new ForbiddenException('Account does not belong to user');
      }

      const sourceToken = this.crypto.decrypt(source.accessToken);
      const destinationToken = this.crypto.decrypt(destination.accessToken);
      let destinationDriveFileId = current.destinationDriveFileId;
      let moveResult: CreatedMoveFiles | null = null;

      if (!destinationDriveFileId) {
        if (current.mimeType === 'application/vnd.google-apps.folder') {
          moveResult = await this.copyFolderTree(current, sourceToken, destinationToken, destination.googleEmail);
        } else if (current.mimeType.startsWith('application/vnd.google-apps.')) {
          moveResult = await this.copyNativeFile(current, sourceToken, destinationToken, destination.googleEmail);
        } else {
          moveResult = await this.uploadBinaryToDestination(current, sourceToken, destinationToken);
        }

        destinationDriveFileId = moveResult.rootFile.id;
        await this.prisma.moveOperation.update({
          where: { id: operationId },
          data: { destinationDriveFileId },
        });
      }

      await this.updateMoveState(operationId, { phase: 'TRASHING_SOURCE' });
      try {
        await this.driveService.trashFile(sourceToken, current.driveFileId);
      } catch (error) {
        if (!(error instanceof NotFoundException)) {
          throw error;
        }
      }

      await this.updateMoveState(operationId, { phase: 'SYNCING_CACHE' });
      if (moveResult) {
        await this.updateFileCacheAfterMove(
          current.sourceAccountId,
          current.destinationAccountId,
          moveResult.sourceDriveFileIds,
          moveResult.createdFiles,
        );
      } else {
        const destinationFile = await this.driveService.getFile(destinationToken, destinationDriveFileId);
        await this.updateFileCacheAfterMove(current.sourceAccountId, current.destinationAccountId, [current.driveFileId], [destinationFile]);
      }

      const completed = await this.updateMoveState(operationId, {
        status: 'COMPLETED',
        phase: 'COMPLETED',
        completedAt: new Date(),
        completedItems: current.totalItems,
        bytesTransferred: current.totalBytes,
        progress: 100,
        error: null,
      });
      await this.notifications.create(current.userId, NotificationType.MOVE_COMPLETE, `${current.fileName} moved successfully`);
      await this.activity.create({
        userId: current.userId,
        type: ActivityEventType.FILE_MOVED,
        message: `${current.fileName} moved successfully`,
        accountId: current.destinationAccountId,
        fileId: destinationDriveFileId,
        operationId,
        metadata: {
          sourceAccountId: current.sourceAccountId,
          destinationAccountId: current.destinationAccountId,
          totalItems: current.totalItems,
        },
      });
      await this.queue.enqueueDuplicateScan(current.userId, 5000);
      this.emitMove(completed);
    } catch (error) {
      const latest = await this.prisma.moveOperation.findUnique({ where: { id: operationId } });
      const message = error instanceof Error ? error.message : 'Move failed';
      const failed = await this.updateMoveState(operationId, {
        status: 'FAILED',
        error: message,
      });
      if (latest) {
        await this.notifications.create(latest.userId, NotificationType.MOVE_FAILED, `Failed to move ${latest.fileName}: ${message}`);
        await this.activity.create({
          userId: latest.userId,
          type: ActivityEventType.MOVE_FAILED,
          message: `Failed to move ${latest.fileName}: ${message}`,
          accountId: latest.sourceAccountId,
          fileId: latest.driveFileId,
          operationId,
        });
      }
      this.emitMove(failed, message);
      if (rethrow) throw error;
    }
  }

  private async uploadBinaryToDestination(
    operation: MoveOperationSnapshot,
    sourceToken: string,
    destinationToken: string,
    parentId?: string,
  ): Promise<CreatedMoveFiles> {
    await this.updateMoveState(operation.id, { phase: 'DOWNLOADING' });
    const download = await this.driveService.downloadFile(sourceToken, operation.driveFileId);
    if (!download.body) {
      throw new BadRequestException('Source file has no downloadable body');
    }

    const sessionUri = await this.driveService.createResumableUploadSession(destinationToken, {
      name: operation.fileName,
      mimeType: operation.mimeType,
      fileSize: Number(operation.sizeBytes),
      parentId,
      origin: this.getFrontendOrigin(),
    });

    await this.updateMoveState(operation.id, { phase: 'UPLOADING' });
    const progressStream = Readable.fromWeb(download.body as never).pipe(
      new MoveProgressTransform(operation.id, this.updateBinaryProgress.bind(this)),
    );
    const uploadResponse = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Type': operation.mimeType,
        'Content-Length': operation.sizeBytes.toString(),
      },
      body: progressStream as never,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new BadRequestException(`Upload to destination failed: ${uploadResponse.status} ${errorText}`);
    }

    const uploaded = (await uploadResponse.json()) as { id?: string };
    if (!uploaded.id) {
      throw new BadRequestException('Drive upload did not return a file id');
    }
    const file = await this.driveService.getFile(destinationToken, uploaded.id);
    await this.incrementCompletedItems(operation.id, 1);
    await this.updateBinaryProgress(operation.id, operation.sizeBytes, true);
    return {
      rootFile: file,
      createdFiles: [file],
      sourceDriveFileIds: [operation.driveFileId],
    };
  }

  private async copyNativeFile(
    operation: MoveOperationSnapshot,
    sourceToken: string,
    destinationToken: string,
    destinationEmail: string,
    parentId?: string,
  ): Promise<CreatedMoveFiles> {
    await this.updateMoveState(operation.id, { phase: 'COPYING_NATIVE' });
    const permissionId = await this.driveService.grantReaderPermission(sourceToken, operation.driveFileId, destinationEmail);
    try {
      const copied = await this.driveService.copyFile(destinationToken, operation.driveFileId, {
        name: operation.fileName,
        parentId,
      });
      await this.incrementCompletedItems(operation.id, 1);
      return {
        rootFile: copied,
        createdFiles: [copied],
        sourceDriveFileIds: [operation.driveFileId],
      };
    } finally {
      if (permissionId) {
        await this.driveService.revokePermission(sourceToken, operation.driveFileId, permissionId);
      }
    }
  }

  private async copyFolderTree(
    operation: MoveOperationSnapshot,
    sourceToken: string,
    destinationToken: string,
    destinationEmail: string,
  ): Promise<CreatedMoveFiles> {
    await this.updateMoveState(operation.id, { phase: 'CREATING_FOLDER' });
    const rootFolder = await this.driveService.createFolder(destinationToken, { name: operation.fileName });
    await this.incrementCompletedItems(operation.id, 1);
    const result: CreatedMoveFiles = {
      rootFile: rootFolder,
      createdFiles: [rootFolder],
      sourceDriveFileIds: [operation.driveFileId],
    };
    await this.copyFolderChildren(operation, sourceToken, destinationToken, destinationEmail, operation.driveFileId, rootFolder.id, result);
    return result;
  }

  private async copyFolderChildren(
    operation: MoveOperationSnapshot,
    sourceToken: string,
    destinationToken: string,
    destinationEmail: string,
    sourceFolderId: string,
    destinationFolderId: string,
    result: CreatedMoveFiles,
  ): Promise<void> {
    await this.updateMoveState(operation.id, { phase: 'MOVING_CHILDREN' });
    let pageToken: string | undefined;
    do {
      const page = await this.driveService.listFolderChildren(sourceToken, sourceFolderId, { pageToken, pageSize: 1000 });
      for (const child of page.files) {
        result.sourceDriveFileIds.push(child.id);
        if (child.mimeType === 'application/vnd.google-apps.folder') {
          const folder = await this.driveService.createFolder(destinationToken, { name: child.name, parentId: destinationFolderId });
          result.createdFiles.push(folder);
          await this.incrementCompletedItems(operation.id, 1);
          await this.copyFolderChildren(operation, sourceToken, destinationToken, destinationEmail, child.id, folder.id, result);
        } else if (child.mimeType.startsWith('application/vnd.google-apps.')) {
          const childOperation = this.childOperation(operation, child);
          const copied = await this.copyNativeFile(childOperation, sourceToken, destinationToken, destinationEmail, destinationFolderId);
          result.createdFiles.push(...copied.createdFiles);
        } else {
          const childOperation = this.childOperation(operation, child);
          const uploaded = await this.uploadBinaryToDestination(childOperation, sourceToken, destinationToken, destinationFolderId);
          result.createdFiles.push(...uploaded.createdFiles);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  private childOperation(parent: MoveOperationSnapshot, file: DriveFile): MoveOperationSnapshot {
    return {
      ...parent,
      driveFileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      sizeBytes: BigInt(file.size || '0'),
    };
  }

  private async getMoveTotals(sourceAccountId: string, file: FileCache): Promise<{ totalBytes: bigint; totalItems: number }> {
    if (!file.isFolder) {
      return {
        totalBytes: file.mimeType.startsWith('application/vnd.google-apps.') ? 0n : file.sizeBytes,
        totalItems: 1,
      };
    }

    // Use cursor-based pagination to avoid loading all files into memory at once
    const BATCH_SIZE = 5000;
    const childrenByParent = new Map<string, Array<{ driveFileId: string; driveParentId: string | null; mimeType: string; sizeBytes: bigint; isFolder: boolean }>>();
    let cursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await this.prisma.fileCache.findMany({
        where: { accountId: sourceAccountId },
        select: { id: true, driveFileId: true, driveParentId: true, mimeType: true, sizeBytes: true, isFolder: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (batch.length === 0) break;

      for (const item of batch) {
        if (!item.driveParentId) continue;
        const children = childrenByParent.get(item.driveParentId) || [];
        children.push(item);
        childrenByParent.set(item.driveParentId, children);
      }

      cursor = batch[batch.length - 1].id;
      if (batch.length < BATCH_SIZE) break;
    }

    let totalItems = 1;
    let totalBytes = 0n;
    const visit = (folderId: string) => {
      for (const child of childrenByParent.get(folderId) || []) {
        totalItems += 1;
        if (!child.isFolder && !child.mimeType.startsWith('application/vnd.google-apps.')) {
          totalBytes += child.sizeBytes;
        }
        if (child.isFolder) {
          visit(child.driveFileId);
        }
      }
    };
    visit(file.driveFileId);
    return { totalBytes, totalItems };
  }

  private async updateFileCacheAfterMove(
    sourceAccountId: string,
    destinationAccountId: string,
    sourceDriveFileIds: string[],
    destinationFiles: DriveFile[],
  ) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.fileCache.deleteMany({ where: { accountId: sourceAccountId, driveFileId: { in: sourceDriveFileIds } } }),
      ...destinationFiles.map((destinationFile) =>
        this.prisma.fileCache.upsert({
          where: { accountId_driveFileId: { accountId: destinationAccountId, driveFileId: destinationFile.id } },
          update: this.toFileCacheUpdate(destinationFile, now),
          create: {
            accountId: destinationAccountId,
            driveFileId: destinationFile.id,
            ...this.toFileCacheUpdate(destinationFile, now),
          },
        }),
      ),
    ]);
  }

  private async updateMoveState(
    operationId: string,
    data: Partial<{
      status: MoveStatus;
      phase: MovePhase;
      startedAt: Date;
      completedAt: Date;
      bytesTransferred: bigint;
      totalBytes: bigint;
      progress: number;
      totalItems: number;
      completedItems: number;
      error: string | null;
    }>,
  ): Promise<MoveOperationSnapshot> {
    const operation = await this.prisma.moveOperation.update({
      where: { id: operationId },
      data,
    });
    this.emitMove(operation);
    return operation;
  }

  private async updateBinaryProgress(operationId: string, bytes: bigint, absolute = false): Promise<void> {
    const operation = await this.prisma.moveOperation.findUnique({ where: { id: operationId } });
    if (!operation) return;
    const nextBytes = absolute ? bytes : operation.bytesTransferred + bytes;
    const progress = this.calculateProgress({
      totalBytes: operation.totalBytes,
      bytesTransferred: nextBytes,
      totalItems: operation.totalItems,
      completedItems: operation.completedItems,
    });
    await this.updateMoveState(operationId, {
      bytesTransferred: nextBytes > operation.totalBytes ? operation.totalBytes : nextBytes,
      progress,
    });
  }

  private async incrementCompletedItems(operationId: string, count: number): Promise<void> {
    const operation = await this.prisma.moveOperation.findUnique({ where: { id: operationId } });
    if (!operation) return;
    const completedItems = Math.min(operation.completedItems + count, operation.totalItems);
    const progress = this.calculateProgress({
      totalBytes: operation.totalBytes,
      bytesTransferred: operation.bytesTransferred,
      totalItems: operation.totalItems,
      completedItems,
    });
    await this.updateMoveState(operationId, { completedItems, progress });
  }

  private calculateProgress(input: {
    totalBytes: bigint;
    bytesTransferred: bigint;
    totalItems: number;
    completedItems: number;
  }): number {
    if (input.totalBytes > 0n) {
      return Math.min(99, Math.floor((Number(input.bytesTransferred) / Number(input.totalBytes)) * 100));
    }
    if (input.totalItems > 0) {
      return Math.min(99, Math.floor((input.completedItems / input.totalItems) * 100));
    }
    return 0;
  }

  private emitMove(operation: MoveOperationSnapshot, error?: string) {
    this.gateway.emitStatus(operation.id, {
      operationId: operation.id,
      status: operation.status,
      phase: operation.phase,
      fileName: operation.fileName,
      bytesTransferred: operation.bytesTransferred.toString(),
      totalBytes: operation.totalBytes.toString(),
      progress: operation.progress,
      totalItems: operation.totalItems,
      completedItems: operation.completedItems,
      destinationAccountId: operation.destinationAccountId,
      error,
    });
  }

  private toFileCacheUpdate(file: DriveFile, now: Date): Omit<FileCache, 'id' | 'accountId' | 'driveFileId' | 'account'> {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    return {
      name: file.name,
      mimeType: file.mimeType,
      fileType: inferFileType(file.mimeType),
      sizeBytes: BigInt(file.size || '0'),
      webViewLink: file.webViewLink || null,
      thumbnailLink: file.thumbnailLink || null,
      thumbnailUpdatedAt: now,
      iconLink: file.iconLink || null,
      driveParentId: file.parents?.[0] || null,
      isFolder,
      driveCreatedAt: file.createdTime ? new Date(file.createdTime) : now,
      driveModifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : now,
      cachedAt: now,
    };
  }

  private getFrontendOrigin(): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3001';
    return new URL(frontendUrl).origin;
  }
}

class MoveProgressTransform extends Transform {
  private pendingBytes = 0n;
  private lastFlushAt = 0;

  constructor(
    private readonly operationId: string,
    private readonly onProgress: (operationId: string, bytes: bigint, absolute?: boolean) => Promise<void>,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pendingBytes += BigInt(chunk.length);
    const shouldFlush = this.pendingBytes >= 1024n * 1024n || Date.now() - this.lastFlushAt > 500;
    if (!shouldFlush) {
      callback(null, chunk);
      return;
    }

    const bytes = this.pendingBytes;
    this.pendingBytes = 0n;
    this.lastFlushAt = Date.now();
    void this.onProgress(this.operationId, bytes).catch(() => undefined);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.pendingBytes > 0n) {
      const bytes = this.pendingBytes;
      this.pendingBytes = 0n;
      void this.onProgress(this.operationId, bytes).catch(() => undefined);
    }
    callback();
  }
}

function inferFileType(mimeType: string): FileType {
  if (mimeType === 'application/vnd.google-apps.document') return FileType.DOCUMENT;
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return FileType.SPREADSHEET;
  if (mimeType === 'application/vnd.google-apps.presentation') return FileType.PRESENTATION;
  if (mimeType === 'application/pdf') return FileType.PDF;
  if (mimeType.startsWith('image/')) return FileType.IMAGE;
  if (mimeType.startsWith('video/')) return FileType.VIDEO;
  if (mimeType.startsWith('audio/')) return FileType.AUDIO;
  if (mimeType === 'application/vnd.google-apps.folder') return FileType.FOLDER;
  return FileType.OTHER;
}
