import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityEventType, AuditAction, ConnectedAccount, FileCache, FileType, Prisma } from '@prisma/client';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Readable, Transform, TransformCallback } from 'stream';
import { ActivityService } from '../activity/activity.service';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { DriveFile, DriveService } from '../drive/drive.service';
import { GoogleAuthService } from '../google-accounts/google-auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';
import { BulkFileOperationDto, BulkFileTargetDto } from './dto/bulk-file-operation.dto';
import { CompleteUploadSessionDto } from './dto/complete-upload-session.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { LargeFilesQueryDto } from './dto/large-files-query.dto';
import { ListFilesQueryDto } from './dto/list-files-query.dto';
import { TrashFilesQueryDto } from './dto/trash-files-query.dto';
import { UploadFromUrlDto } from './dto/upload-from-url.dto';

const CACHE_TTL_MS = 5 * 60 * 1000;
const FILE_CACHE_WRITE_BATCH_SIZE = 5;
const THUMBNAIL_METADATA_TTL_MS = 12 * 60 * 60 * 1000;
const THUMBNAIL_BYTES_TTL_MS = 5 * 60 * 1000;
const BULK_FILE_CONCURRENCY = 3;
const DEFAULT_URL_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;

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
    private readonly googleAuth: GoogleAuthService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
    private readonly configService: ConfigService,
    private readonly activity: ActivityService,
    private readonly featureGuard: FeatureGuardService,
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
      ...(query.minSizeBytes || query.maxSizeBytes
        ? {
            sizeBytes: {
              ...(query.minSizeBytes ? { gte: BigInt(query.minSizeBytes) } : {}),
              ...(query.maxSizeBytes ? { lte: BigInt(query.maxSizeBytes) } : {}),
            },
          }
        : {}),
      ...(query.modifiedAfter || query.modifiedBefore
        ? {
            driveModifiedAt: {
              ...(query.modifiedAfter ? { gte: new Date(query.modifiedAfter) } : {}),
              ...(query.modifiedBefore ? { lte: new Date(query.modifiedBefore) } : {}),
            },
          }
        : {}),
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

  async getLargeFiles(userId: string, query: LargeFilesQueryDto) {
    if (query.accountId) {
      await this.getOwnedAccount(userId, query.accountId);
    }

    return this.prisma.fileCache.findMany({
      where: {
        account: { userId },
        ...(query.accountId ? { accountId: query.accountId } : {}),
        isFolder: false,
        sizeBytes: { gte: query.minSizeBytes ? BigInt(query.minSizeBytes) : 100n * 1024n * 1024n },
      },
      orderBy: { sizeBytes: 'desc' },
      take: query.limit,
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
    });
  }

  async getCleanupSuggestions(userId: string) {
    const [largestFiles, duplicateGroups, accounts, oldLargeVideos] = await Promise.all([
      this.getLargeFiles(userId, { limit: 20 }),
      this.prisma.duplicateGroup.findMany({
        where: { userId },
        orderBy: { sizeBytes: 'desc' },
        take: 20,
      }),
      this.prisma.connectedAccount.findMany({
        where: { userId },
        orderBy: { storageUsed: 'desc' },
        select: {
          id: true,
          googleEmail: true,
          displayName: true,
          storageLimit: true,
          storageUsed: true,
          isDefault: true,
        },
      }),
      this.prisma.fileCache.findMany({
        where: {
          account: { userId },
          fileType: 'VIDEO',
          sizeBytes: { gte: 100n * 1024n * 1024n },
          driveModifiedAt: { lt: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) },
        },
        orderBy: { sizeBytes: 'desc' },
        take: 20,
        include: {
          account: {
            select: { id: true, googleEmail: true, displayName: true },
          },
        },
      }),
    ]);

    const duplicateRecoverableBytes = duplicateGroups.reduce((sum, group) => {
      return sum + group.sizeBytes * BigInt(Math.max(group.fileIds.length - 1, 0));
    }, 0n);
    const nearQuotaAccounts = accounts.filter((account) => {
      if (account.storageLimit <= 0n) return false;
      return Number(account.storageUsed) / Number(account.storageLimit) >= 0.8;
    });

    return {
      largestFiles,
      duplicates: {
        groups: duplicateGroups.length,
        recoverableBytes: duplicateRecoverableBytes,
        sample: duplicateGroups,
      },
      nearQuotaAccounts,
      oldLargeVideos,
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
    await this.activity.create({
      userId,
      type: ActivityEventType.UPLOAD_COMPLETED,
      message: `${session.fileName} uploaded successfully`,
      accountId: session.accountId,
      fileId: driveFileId,
      metadata: { sessionId, bytesUploaded },
    });
    await this.invalidateAccountCache(session.accountId);
    await this.queue.enqueueDuplicateScan(userId, 5000);
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

    await this.driveService.trashFile(this.crypto.decrypt(account.accessToken), fileId);
    await this.prisma.fileCache.deleteMany({ where: { accountId, driveFileId: fileId } });
    await this.invalidateAccountCache(accountId);
    await this.audit.log({
      userId,
      accountId,
      resourceId: fileId,
      action: AuditAction.FILE_DELETED,
    });
    await this.activity.create({
      userId,
      type: ActivityEventType.FILE_TRASHED,
      message: `File moved to trash`,
      accountId,
      fileId,
    });
  }

  async bulkDelete(userId: string, dto: BulkFileOperationDto) {
    const results = this.createBulkResults();
    for (const batch of chunk(dto.files, BULK_FILE_CONCURRENCY)) {
      await Promise.all(batch.map((file) => this.runBulkFileOperation(results, file, (target) => this.trashFile(userId, target))));
    }
    await this.queue.enqueueQuotaRefresh(userId);
    await this.queue.enqueueDuplicateScan(userId, 5000);
    return results;
  }

  async bulkRestore(userId: string, dto: BulkFileOperationDto) {
    const results = this.createBulkResults();
    for (const batch of chunk(dto.files, BULK_FILE_CONCURRENCY)) {
      await Promise.all(batch.map((file) => this.runBulkFileOperation(results, file, (target) => this.restoreFile(userId, target))));
    }
    await this.queue.enqueueQuotaRefresh(userId);
    await this.queue.enqueueDuplicateScan(userId, 5000);
    return results;
  }

  async getPreviewUrl(userId: string, accountId: string, fileId: string) {
    await this.featureGuard.requireFeature(userId, 'file_preview');
    const { account, file } = await this.getOwnedAccountFile(userId, accountId, fileId);
    if (file.mimeType.startsWith('application/vnd.google-apps.')) {
      const refreshed = await this.driveService.getFile(this.crypto.decrypt(account.accessToken), fileId);
      return {
        previewUrl: refreshed.webViewLink || file.webViewLink,
        type: 'embed',
        mimeType: refreshed.mimeType,
        name: refreshed.name,
      };
    }

    return {
      previewUrl: `/files/stream/${encodeURIComponent(accountId)}/${encodeURIComponent(fileId)}`,
      type: 'stream',
      mimeType: file.mimeType,
      name: file.name,
    };
  }

  async listTrash(userId: string, query: TrashFilesQueryDto) {
    const account = await this.getOwnedAccount(userId, query.accountId);
    const result = await this.driveService.listFiles(this.crypto.decrypt(account.accessToken), {
      pageSize: query.limit,
      pageToken: query.pageToken,
      query: 'trashed=true',
    });

    return {
      data: result.files.map((file) => ({
        ...file,
        account: {
          id: account.id,
          googleEmail: account.googleEmail,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
        },
      })),
      nextPageToken: result.nextPageToken,
    };
  }

  async restoreTrashedFile(userId: string, accountId: string, fileId: string) {
    const account = await this.getOwnedAccount(userId, accountId);
    const accessToken = this.crypto.decrypt(account.accessToken);
    await this.driveService.restoreFile(accessToken, fileId);
    const restored = await this.driveService.getFile(accessToken, fileId);
    await this.upsertCacheFile(accountId, restored);
    await this.invalidateAccountCache(accountId);
    await this.activity.create({
      userId,
      type: ActivityEventType.FILE_RESTORED,
      message: `${restored.name} restored from trash`,
      accountId,
      fileId,
    });
    return { success: true };
  }

  async streamFile(userId: string, accountId: string, fileId: string, res: import('express').Response): Promise<void> {
    const { account, file } = await this.getOwnedAccountFile(userId, accountId, fileId);
    if (file.mimeType.startsWith('application/vnd.google-apps.')) {
      throw new BadRequestException('Google Workspace files cannot be streamed as raw media');
    }

    const googleRes = await this.driveService.downloadFile(this.crypto.decrypt(account.accessToken), fileId);
    if (!googleRes.body) {
      throw new NotFoundException('File stream unavailable');
    }

    const contentLength = googleRes.headers.get('content-length');
    res.setHeader('Content-Type', googleRes.headers.get('content-type') || file.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${safeHeaderFileName(file.name)}"`);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    Readable.fromWeb(googleRes.body as never).pipe(res);
  }

  async uploadFromUrl(userId: string, dto: UploadFromUrlDto) {
    await this.featureGuard.requireFeature(userId, 'upload_from_url');
    const account = await this.getOwnedAccount(userId, dto.accountId);
    const maxBytes = this.getUrlUploadMaxBytes();
    const { response, resolvedUrl } = await this.fetchRemoteUrl(dto.url, maxBytes);
    if (!response.body) {
      throw new BadRequestException('Remote URL did not return a file body');
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    const fileName = dto.fileName || extractFilenameFromUrl(resolvedUrl) || 'download';
    const accessToken = this.crypto.decrypt(account.accessToken);
    const sessionUri = await this.driveService.createResumableUploadSession(accessToken, {
      name: fileName,
      mimeType: contentType,
      fileSize: contentLength ? Number(contentLength) : undefined,
      origin: this.getFrontendOrigin(),
    });

    const limitedBody = Readable.fromWeb(response.body as never).pipe(new ByteLimitTransform(maxBytes));
    const uploadRes = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
      },
      body: limitedBody as never,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    if (!uploadRes.ok) {
      const errorText = await uploadRes.text();
      throw new BadRequestException(`Upload to Drive failed: ${uploadRes.status} ${errorText}`);
    }

    const uploaded = (await uploadRes.json()) as { id?: string };
    if (!uploaded.id) {
      throw new BadRequestException('Drive upload did not return a file id');
    }
    const driveFile = await this.driveService.getFile(accessToken, uploaded.id);
    await this.upsertCacheFile(account.id, driveFile);
    await this.invalidateAccountCache(account.id);
    await this.queue.enqueueQuotaRefresh(userId);
    await this.queue.enqueueDuplicateScan(userId, 5000);
    await this.activity.create({
      userId,
      type: ActivityEventType.URL_UPLOAD_COMPLETED,
      message: `${driveFile.name} saved from URL`,
      accountId: account.id,
      fileId: uploaded.id,
      metadata: { sourceUrl: resolvedUrl },
    });
    return {
      driveFileId: uploaded.id,
      fileName: driveFile.name,
      accountId: account.id,
    };
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

    // Skip sync entirely if the account already needs re-auth
    if (account.status === 'REAUTH_REQUIRED') {
      this.logger.warn(`Skipping file sync for account ${account.id} (${account.googleEmail}) — re-authentication required`);
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

    try {
      const accessToken = await this.getValidAccessToken(account);
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
      const isAuthError = error instanceof ForbiddenException || error instanceof UnauthorizedException;

      if (isAuthError) {
        // Token refresh was attempted and failed, or scope was revoked — mark REAUTH_REQUIRED
        await this.prisma.connectedAccount.update({
          where: { id: account.id },
          data: {
            status: 'REAUTH_REQUIRED',
            reauthRequiredAt: new Date(),
            lastSyncError: message,
          },
        });
        await this.audit.log({
          userId: account.userId,
          accountId: account.id,
          action: AuditAction.GOOGLE_ACCOUNT_REAUTH_REQUIRED,
        });
        this.logger.warn(`Account ${account.id} (${account.googleEmail}) marked REAUTH_REQUIRED during file sync: ${message}`);
      } else {
        await this.prisma.connectedAccount.update({
          where: { id: account.id },
          data: { status: 'SYNC_FAILED', lastSyncError: message },
        });
      }

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

  /**
   * Gets a valid access token for the account, attempting a refresh if needed.
   * If refresh succeeds but Drive still returns 403, throws ForbiddenException.
   */
  private async getValidAccessToken(account: ConnectedAccount): Promise<string> {
    const currentToken = this.crypto.decrypt(account.accessToken);

    // If token hasn't expired yet, use it directly
    if (account.expiresAt && account.expiresAt.getTime() > Date.now() + 60_000) {
      return currentToken;
    }

    // Token is expired or about to expire — attempt refresh
    if (!account.refreshToken) {
      throw new ForbiddenException(`No refresh token available for account ${account.googleEmail}. Please reconnect.`);
    }

    try {
      const creds = await this.googleAuth.refreshAccessToken(this.crypto.decrypt(account.refreshToken));
      if (!creds.access_token || !creds.expiry_date) {
        throw new ForbiddenException(`Token refresh returned no credentials for account ${account.googleEmail}`);
      }

      await this.prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          accessToken: this.crypto.encrypt(creds.access_token),
          ...(creds.refresh_token ? { refreshToken: this.crypto.encrypt(creds.refresh_token) } : {}),
          expiresAt: new Date(creds.expiry_date),
          status: 'ACTIVE',
          reauthRequiredAt: null,
          lastSyncError: null,
        },
      });

      await this.audit.log({
        userId: account.userId,
        accountId: account.id,
        action: AuditAction.GOOGLE_ACCOUNT_REAUTHED,
      });

      this.logger.log(`Token refreshed for account ${account.id} (${account.googleEmail}) before file sync`);
      return creds.access_token;
    } catch (error) {
      this.logger.warn(`Token refresh failed for account ${account.id} (${account.googleEmail}): ${error instanceof Error ? error.message : String(error)}`);
      throw new ForbiddenException(`Token refresh failed for account ${account.googleEmail}. Please reconnect.`);
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

  private async getOwnedAccount(userId: string, accountId: string): Promise<ConnectedAccount> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }
    return account;
  }

  private async trashFile(userId: string, file: BulkFileTargetDto): Promise<void> {
    const account = await this.getOwnedAccount(userId, file.accountId);
    await this.driveService.trashFile(this.crypto.decrypt(account.accessToken), file.driveFileId);
    await this.prisma.fileCache.deleteMany({ where: { accountId: file.accountId, driveFileId: file.driveFileId } });
    await this.invalidateAccountCache(file.accountId);
    await this.audit.log({
      userId,
      accountId: file.accountId,
      resourceId: file.driveFileId,
      action: AuditAction.FILE_DELETED,
    });
    await this.activity.create({
      userId,
      type: ActivityEventType.FILE_TRASHED,
      message: `File moved to trash`,
      accountId: file.accountId,
      fileId: file.driveFileId,
    });
  }

  private async restoreFile(userId: string, file: BulkFileTargetDto): Promise<void> {
    const account = await this.getOwnedAccount(userId, file.accountId);
    const accessToken = this.crypto.decrypt(account.accessToken);
    await this.driveService.restoreFile(accessToken, file.driveFileId);
    const restored = await this.driveService.getFile(accessToken, file.driveFileId);
    await this.upsertCacheFile(file.accountId, restored);
    await this.invalidateAccountCache(file.accountId);
    await this.activity.create({
      userId,
      type: ActivityEventType.FILE_RESTORED,
      message: `${restored.name} restored from trash`,
      accountId: file.accountId,
      fileId: file.driveFileId,
    });
  }

  private createBulkResults(): {
    success: number;
    failed: number;
    errors: Array<{ accountId: string; driveFileId: string; message: string }>;
  } {
    return { success: 0, failed: 0, errors: [] };
  }

  private async runBulkFileOperation(
    results: {
      success: number;
      failed: number;
      errors: Array<{ accountId: string; driveFileId: string; message: string }>;
    },
    file: BulkFileTargetDto,
    operation: (file: BulkFileTargetDto) => Promise<void>,
  ): Promise<void> {
    try {
      await operation(file);
      results.success += 1;
    } catch (error) {
      results.failed += 1;
      results.errors.push({
        accountId: file.accountId,
        driveFileId: file.driveFileId,
        message: error instanceof Error ? error.message : 'File operation failed',
      });
    }
  }

  private async fetchRemoteUrl(url: string, maxBytes: number): Promise<{ response: Response; resolvedUrl: string }> {
    let currentUrl = url;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      await this.assertPublicHttpUrl(currentUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            throw new BadRequestException('Remote URL redirected without a location header');
          }
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        if (!response.ok) {
          throw new BadRequestException('Could not fetch from URL');
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && Number(contentLength) > maxBytes) {
          throw new BadRequestException('Remote file is larger than the upload limit');
        }

        return { response, resolvedUrl: currentUrl };
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new BadRequestException('Remote URL redirected too many times');
  }

  private async assertPublicHttpUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('Only HTTP and HTTPS URLs are supported');
    }

    if (!parsed.hostname || parsed.username || parsed.password) {
      throw new BadRequestException('URL is not allowed');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new BadRequestException('Local URLs are not allowed');
    }

    const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
      throw new BadRequestException('Private network URLs are not allowed');
    }
  }

  private getUrlUploadMaxBytes(): number {
    const configured = Number(this.configService.get<string>('URL_UPLOAD_MAX_BYTES'));
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_URL_UPLOAD_MAX_BYTES;
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

function safeHeaderFileName(fileName: string): string {
  return fileName.replace(/[\r\n"]/g, '_');
}

function extractFilenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop();
    if (!segment) return null;
    return decodeURIComponent(segment).replace(/[/\\]/g, '_').slice(0, 255) || null;
  } catch {
    return null;
  }
}

function isPrivateIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map((part) => Number(part));
    const [first, second] = parts;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first >= 224
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true;
    }
    if (normalized.startsWith('fe80:')) {
      return true;
    }
    const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mappedIpv4 ? isPrivateIp(mappedIpv4[1]) : false;
  }

  return true;
}

class ByteLimitTransform extends Transform {
  private total = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.total += chunk.length;
    if (this.total > this.maxBytes) {
      callback(new BadRequestException('Remote file is larger than the upload limit'));
      return;
    }
    callback(null, chunk);
  }
}
