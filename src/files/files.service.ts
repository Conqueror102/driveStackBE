import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, ConnectedAccount, FileCache, FileType, Prisma } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { DriveFile, DriveService } from '../drive/drive.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { CompleteUploadSessionDto } from './dto/complete-upload-session.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { ListFilesQueryDto } from './dto/list-files-query.dto';

const CACHE_TTL_MS = 5 * 60 * 1000;
const FILE_CACHE_WRITE_BATCH_SIZE = 5;
const THUMBNAIL_METADATA_TTL_MS = 12 * 60 * 60 * 1000;
const THUMBNAIL_BYTES_TTL_MS = 5 * 60 * 1000;

type ThumbnailCacheEntry = {
  bytes: Buffer;
  contentType: string;
  expiresAt: number;
};

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly thumbnailBytesCache = new Map<string, ThumbnailCacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly driveService: DriveService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly configService: ConfigService,
  ) {}

  async listFiles(userId: string, query: ListFilesQueryDto) {
    const accounts = await this.prisma.connectedAccount.findMany({
      where: { userId, ...(query.accountId ? { id: query.accountId } : {}) },
    });

    if (query.accountId && accounts.length === 0) {
      throw new ForbiddenException('Account does not belong to user');
    }

    await Promise.all(
      accounts.map(async (account) => {
        if (!(await this.isCacheStale(account.id))) return;
        const queued = await this.queue.enqueueFileSync(account.userId, account.id);
        if (!queued) {
          await this.refreshCacheIfStale(account);
        }
      }),
    );

    const where: Prisma.FileCacheWhereInput = {
      account: { userId },
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.fileType ? { fileType: query.fileType } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.parentId ? { driveParentId: query.parentId } : {}),
    };
    const orderBy = this.buildOrderBy(query);
    const [total, data] = await this.prisma.$transaction([
      this.prisma.fileCache.count({ where }),
      this.prisma.fileCache.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          account: {
            select: {
              id: true,
              googleEmail: true,
              displayName: true,
              avatarUrl: true,
            },
          },
        },
      }),
    ]);

    const accountById = new Map(accounts.map((account) => [account.id, account]));
    await this.refreshThumbnailMetadataForList(userId, data, accountById);

    return {
      data: data.map((file) => this.withThumbnailProxyUrl(file)),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        lastPage: Math.ceil(total / query.limit),
      },
    };
  }

  async createUploadSession(userId: string, dto: CreateUploadSessionDto) {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: dto.accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    const sessionUri = await this.driveService.createResumableUploadSession(
      this.crypto.decrypt(account.accessToken),
      {
        name: dto.fileName,
        mimeType: dto.mimeType,
        fileSize: dto.fileSize,
        parentId: dto.parentId,
        origin: this.getFrontendOrigin(),
      },
    );

    const session = await this.prisma.uploadSession.create({
      data: {
        userId,
        accountId: dto.accountId,
        sessionUri,
        fileName: dto.fileName,
        mimeType: dto.mimeType,
        fileType: inferFileType(dto.mimeType),
        fileSize: BigInt(dto.fileSize),
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await this.audit.log({
      userId,
      accountId: dto.accountId,
      resourceId: session.id,
      action: AuditAction.UPLOAD_SESSION_CREATED,
      metadata: { fileName: dto.fileName, mimeType: dto.mimeType, fileSize: dto.fileSize },
    });
    return session;
  }

  async getUploadSession(userId: string, sessionId: string) {
    const session = await this.prisma.uploadSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (session.userId !== userId) {
      throw new ForbiddenException('Upload session does not belong to user');
    }
    return session;
  }

  async completeUpload(userId: string, sessionId: string, dto: CompleteUploadSessionDto) {
    const session = await this.prisma.uploadSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (session.userId !== userId) {
      throw new ForbiddenException('Upload session does not belong to user');
    }
    await this.prisma.uploadSession.update({
      where: { id: sessionId },
      data: { status: 'IN_PROGRESS' },
    });
    const queued = await this.queue.enqueueUploadVerification(userId, sessionId, dto.driveFileId, dto.bytesUploaded);
    if (queued) {
      return { queued: true };
    }
    await this.verifyUpload(userId, sessionId, dto.driveFileId, dto.bytesUploaded);
    return { queued: false, completed: true };
  }

  async verifyUpload(userId: string, sessionId: string, driveFileId: string, bytesUploaded: string): Promise<void> {
    const session = await this.prisma.uploadSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (session.userId !== userId) {
      throw new ForbiddenException('Upload session does not belong to user');
    }

    const account = await this.prisma.connectedAccount.findUnique({ where: { id: session.accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    const driveFile = await this.driveService.getFile(this.crypto.decrypt(account.accessToken), driveFileId);
    if (driveFile.mimeType !== session.mimeType) {
      await this.markUploadFailed(sessionId, 'Uploaded file MIME type does not match upload session');
      throw new BadRequestException('Uploaded file MIME type does not match upload session');
    }
    if (driveFile.size && BigInt(driveFile.size) !== BigInt(bytesUploaded)) {
      await this.markUploadFailed(sessionId, 'Uploaded byte count does not match Google Drive file size');
      throw new BadRequestException('Uploaded byte count does not match Google Drive file size');
    }
    if (driveFile.name && driveFile.name !== session.fileName) {
      await this.markUploadFailed(sessionId, 'Uploaded file name does not match upload session');
      throw new BadRequestException('Uploaded file name does not match upload session');
    }

    await this.prisma.uploadSession.update({
      where: { id: sessionId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        bytesUploaded: BigInt(bytesUploaded),
        driveFileId,
        verifiedAt: new Date(),
      },
    });
    await this.upsertCacheFile(session.accountId, driveFile);
    await this.audit.log({
      userId,
      accountId: session.accountId,
      resourceId: sessionId,
      action: AuditAction.UPLOAD_COMPLETED,
      metadata: { driveFileId, bytesUploaded },
    });
    await this.invalidateAccountCache(session.accountId);
  }

  async syncAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }
    await this.refreshCacheIfStale(account, true);
  }

  async getFileLinks(userId: string, accountId: string, fileId: string) {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }
    const file = await this.driveService.getFile(this.crypto.decrypt(account.accessToken), fileId);
    return {
      driveFileId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      webViewLink: file.webViewLink || null,
      webContentLink: file.webContentLink || null,
      exportLinks: file.exportLinks || {},
    };
  }

  async getThumbnail(userId: string, accountId: string, fileId: string): Promise<{ bytes: Buffer; contentType: string }> {
    const { account, file } = await this.getOwnedAccountFile(userId, accountId, fileId);
    const refreshedFile = await this.refreshThumbnailMetadataIfNeeded(account, file);
    if (!refreshedFile.thumbnailLink) {
      throw new NotFoundException('Thumbnail unavailable');
    }

    const cacheKey = this.thumbnailCacheKey(accountId, fileId, refreshedFile);
    const cached = this.thumbnailBytesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { bytes: cached.bytes, contentType: cached.contentType };
    }
    if (cached) {
      this.thumbnailBytesCache.delete(cacheKey);
    }

    const thumbnail = await this.driveService.fetchThumbnail(
      this.crypto.decrypt(account.accessToken),
      refreshedFile.thumbnailLink,
    );
    this.thumbnailBytesCache.set(cacheKey, {
      ...thumbnail,
      expiresAt: Date.now() + THUMBNAIL_BYTES_TTL_MS,
    });
    this.pruneThumbnailCache();
    return thumbnail;
  }

  async deleteFile(userId: string, accountId: string, fileId: string): Promise<void> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    await this.driveService.deleteFile(this.crypto.decrypt(account.accessToken), fileId);
    await this.prisma.fileCache.deleteMany({ where: { accountId, driveFileId: fileId } });
    await this.invalidateAccountCache(accountId);
    await this.audit.log({
      userId,
      accountId,
      resourceId: fileId,
      action: AuditAction.FILE_DELETED,
    });
  }

  private async isCacheStale(accountId: string): Promise<boolean> {
    const newest = await this.prisma.fileCache.findFirst({
      where: { accountId },
      orderBy: { cachedAt: 'desc' },
      select: { cachedAt: true },
    });
    return !newest || newest.cachedAt.getTime() < Date.now() - CACHE_TTL_MS;
  }

  private async refreshCacheIfStale(account: ConnectedAccount, force = false): Promise<void> {
    const stale = force || (await this.isCacheStale(account.id));
    if (!stale) {
      return;
    }

    const syncJob = await this.prisma.syncJob.create({
      data: {
        userId: account.userId,
        accountId: account.id,
        status: 'RUNNING',
      },
    });
    await this.audit.log({
      userId: account.userId,
      accountId: account.id,
      resourceId: syncJob.id,
      action: AuditAction.FILE_SYNC_STARTED,
    });

    const accessToken = this.crypto.decrypt(account.accessToken);
    try {
      const result = account.driveChangesPageToken
        ? await this.incrementalSync(account.id, accessToken, account.driveChangesPageToken)
        : await this.fullSync(account.id, accessToken);
      await this.prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          status: 'ACTIVE',
          lastSyncAt: new Date(),
          lastSyncError: null,
          driveChangesPageToken: result.nextChangesPageToken,
        },
      });
      await this.prisma.syncJob.update({
        where: { id: syncJob.id },
        data: { status: 'SUCCEEDED', finishedAt: new Date() },
      });
      await this.audit.log({
        userId: account.userId,
        accountId: account.id,
        resourceId: syncJob.id,
        action: AuditAction.FILE_SYNC_SUCCEEDED,
        metadata: result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Drive sync failed';
      await this.prisma.connectedAccount.update({
        where: { id: account.id },
        data: { status: 'SYNC_FAILED', lastSyncError: message },
      });
      await this.prisma.syncJob.update({
        where: { id: syncJob.id },
        data: { status: 'FAILED', error: message, finishedAt: new Date() },
      });
      await this.audit.log({
        userId: account.userId,
        accountId: account.id,
        resourceId: syncJob.id,
        action: AuditAction.FILE_SYNC_FAILED,
        metadata: { message },
      });
      this.logger.error(`Drive file sync failed for account ${account.id}`, error instanceof Error ? error.stack : String(error));
    }
  }

  private async fullSync(accountId: string, accessToken: string) {
    this.logger.log(`Starting full Drive sync for account ${accountId}`);
    const seenFileIds = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.driveService.listFiles(accessToken, { pageToken, pageSize: 1000 });
      page.files.forEach((file) => seenFileIds.add(file.id));
      await this.upsertCacheFiles(accountId, page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);

    await this.prisma.fileCache.deleteMany({
      where: { accountId, driveFileId: { notIn: [...seenFileIds] } },
    });
    const nextChangesPageToken = await this.driveService.getStartPageToken(accessToken);
    this.logger.log(`Full Drive sync completed for account ${accountId}: ${seenFileIds.size} files`);
    return {
      mode: 'full',
      fileCount: seenFileIds.size,
      removedCount: 0,
      nextChangesPageToken,
    };
  }

  private async incrementalSync(accountId: string, accessToken: string, startPageToken: string) {
    this.logger.log(`Starting incremental Drive sync for account ${accountId}`);
    let pageToken: string | undefined = startPageToken;
    let newStartPageToken: string | undefined;
    let changedCount = 0;
    let removedCount = 0;

    try {
      do {
        const page = await this.driveService.listChanges(accessToken, pageToken);
        for (const batch of chunk(page.changes, FILE_CACHE_WRITE_BATCH_SIZE)) {
          await Promise.all(
            batch.map(async (change) => {
              if (!change.fileId) return;
              if (change.removed || !change.file) {
                removedCount += 1;
                await this.prisma.fileCache.deleteMany({ where: { accountId, driveFileId: change.fileId } });
                return;
              }
              changedCount += 1;
              await this.upsertCacheFile(accountId, change.file);
            }),
          );
        }
        pageToken = page.nextPageToken;
        newStartPageToken = page.newStartPageToken || newStartPageToken;
      } while (pageToken);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 410) {
        this.logger.warn(`Drive changes token expired for account ${accountId}; falling back to full sync`);
        return this.fullSync(accountId, accessToken);
      }
      throw error;
    }

    this.logger.log(`Incremental Drive sync completed for account ${accountId}: ${changedCount} changed, ${removedCount} removed`);
    return {
      mode: 'incremental',
      fileCount: changedCount,
      removedCount,
      nextChangesPageToken: newStartPageToken || startPageToken,
    };
  }

  private async markUploadFailed(sessionId: string, reason: string) {
    await this.prisma.uploadSession.update({
      where: { id: sessionId },
      data: { status: 'FAILED' },
    });
    this.logger.warn(`Upload verification failed for session ${sessionId}: ${reason}`);
  }

  private async upsertCacheFiles(accountId: string, files: DriveFile[]): Promise<void> {
    for (const batch of chunk(files, FILE_CACHE_WRITE_BATCH_SIZE)) {
      await Promise.all(batch.map((file) => this.upsertCacheFile(accountId, file)));
    }
  }

  private upsertCacheFile(accountId: string, file: DriveFile): Promise<FileCache> {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    const now = new Date();
    return this.prisma.fileCache.upsert({
      where: { accountId_driveFileId: { accountId, driveFileId: file.id } },
      update: {
        name: file.name,
        mimeType: file.mimeType,
        fileType: inferFileType(file.mimeType),
        sizeBytes: BigInt(file.size || '0'),
        webViewLink: file.webViewLink,
        thumbnailLink: file.thumbnailLink,
        thumbnailUpdatedAt: now,
        iconLink: file.iconLink,
        driveParentId: file.parents?.[0],
        isFolder,
        driveCreatedAt: file.createdTime ? new Date(file.createdTime) : now,
        driveModifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : now,
        cachedAt: now,
      },
      create: {
        accountId,
        driveFileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        fileType: inferFileType(file.mimeType),
        sizeBytes: BigInt(file.size || '0'),
        webViewLink: file.webViewLink,
        thumbnailLink: file.thumbnailLink,
        thumbnailUpdatedAt: now,
        iconLink: file.iconLink,
        driveParentId: file.parents?.[0],
        isFolder,
        driveCreatedAt: file.createdTime ? new Date(file.createdTime) : now,
        driveModifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : now,
        cachedAt: now,
      },
    });
  }

  private async invalidateAccountCache(accountId: string) {
    await this.prisma.fileCache.updateMany({
      where: { accountId },
      data: { cachedAt: new Date(0) },
    });
  }

  private buildOrderBy(query: ListFilesQueryDto): Prisma.FileCacheOrderByWithRelationInput {
    if (query.sortBy === 'name') return { name: query.sortOrder };
    if (query.sortBy === 'size') return { sizeBytes: query.sortOrder };
    return { driveModifiedAt: query.sortOrder };
  }

  private async refreshThumbnailMetadataForList(
    userId: string,
    files: FileCache[],
    accountById: Map<string, ConnectedAccount>,
  ): Promise<void> {
    const staleFiles = files.filter((file) => this.shouldRefreshThumbnailMetadata(file));
    for (const batch of chunk(staleFiles, FILE_CACHE_WRITE_BATCH_SIZE)) {
      await Promise.all(
        batch.map(async (file) => {
          try {
            const account = accountById.get(file.accountId);
            if (!account) return;
            if (account.userId !== userId) return;
            const refreshed = await this.refreshThumbnailMetadataIfNeeded(account, file);
            file.thumbnailLink = refreshed.thumbnailLink;
            file.thumbnailUpdatedAt = refreshed.thumbnailUpdatedAt;
            file.iconLink = refreshed.iconLink;
            file.driveModifiedAt = refreshed.driveModifiedAt;
          } catch (error) {
            this.logger.warn(
              `Thumbnail metadata refresh failed for file ${file.driveFileId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }),
      );
    }
  }

  private async refreshThumbnailMetadataIfNeeded(
    account: Pick<ConnectedAccount, 'id' | 'accessToken' | 'userId'>,
    file: FileCache,
  ): Promise<FileCache> {
    if (!this.shouldRefreshThumbnailMetadata(file)) {
      return file;
    }

    const metadata = await this.driveService.getThumbnailMetadata(
      this.crypto.decrypt(account.accessToken),
      file.driveFileId,
    );
    return this.prisma.fileCache.update({
      where: { accountId_driveFileId: { accountId: account.id, driveFileId: file.driveFileId } },
      data: {
        name: metadata.name || file.name,
        mimeType: metadata.mimeType || file.mimeType,
        fileType: inferFileType(metadata.mimeType || file.mimeType),
        thumbnailLink: metadata.thumbnailLink,
        thumbnailUpdatedAt: new Date(),
        iconLink: metadata.iconLink,
        driveModifiedAt: metadata.modifiedTime ? new Date(metadata.modifiedTime) : file.driveModifiedAt,
      },
    });
  }

  private shouldRefreshThumbnailMetadata(file: Pick<FileCache, 'thumbnailLink' | 'thumbnailUpdatedAt'>): boolean {
    return !file.thumbnailUpdatedAt || Date.now() - file.thumbnailUpdatedAt.getTime() > THUMBNAIL_METADATA_TTL_MS;
  }

  private async getOwnedAccountFile(userId: string, accountId: string, fileId: string) {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    const file = await this.prisma.fileCache.findUnique({
      where: { accountId_driveFileId: { accountId, driveFileId: fileId } },
    });
    if (!file) {
      throw new NotFoundException('File not found');
    }
    return { account, file };
  }

  private withThumbnailProxyUrl<T extends Pick<FileCache, 'accountId' | 'driveFileId'> & { thumbnailLink?: string | null }>(file: T) {
    return {
      ...file,
      thumbnailLink: file.thumbnailLink || null,
      thumbnailProxyUrl: `/files/${encodeURIComponent(file.accountId)}/${encodeURIComponent(file.driveFileId)}/thumbnail`,
    };
  }

  private thumbnailCacheKey(accountId: string, fileId: string, file: Pick<FileCache, 'driveModifiedAt' | 'thumbnailUpdatedAt'>): string {
    const version = file.driveModifiedAt?.toISOString() || file.thumbnailUpdatedAt?.toISOString() || 'unknown';
    return `${accountId}:${fileId}:${version}`;
  }

  private pruneThumbnailCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.thumbnailBytesCache.entries()) {
      if (entry.expiresAt <= now) {
        this.thumbnailBytesCache.delete(key);
      }
    }
  }

  private getFrontendOrigin(): string {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    return new URL(frontendUrl).origin;
  }
}

export function inferFileType(mimeType: string): FileType {
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

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
