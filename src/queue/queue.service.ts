import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../redis/redis.service';

export const FILE_SYNC_QUEUE = 'file-sync';
export const QUOTA_REFRESH_QUEUE = 'quota-refresh';
export const TOKEN_REFRESH_QUEUE = 'token-refresh';
export const UPLOAD_VERIFY_QUEUE = 'upload-verify';
export const MOVE_FILE_QUEUE = 'move-file';
export const DUPLICATE_SCAN_QUEUE = 'duplicate-scan';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly redis: RedisService) {}

  isEnabled(): boolean {
    return this.redis.isEnabled();
  }

  getQueue(name: string): Queue | null {
    if (!this.redis.isEnabled()) return null;
    const existing = this.queues.get(name);
    if (existing) return existing;

    try {
      const queue = new Queue(name, { connection: this.redis.duplicate() as never });
      queue.on('error', (error) => {
        this.logger.warn(`Queue "${name}" Redis error: ${error.message}`);
      });
      this.queues.set(name, queue);
      return queue;
    } catch (error) {
      this.logger.warn(`Queue "${name}" unavailable; falling back to inline behavior: ${this.errorMessage(error)}`);
      return null;
    }
  }

  async enqueueFileSync(userId: string, accountId: string): Promise<boolean> {
    return this.enqueue(FILE_SYNC_QUEUE, (queue) =>
      queue.add(
        'sync-account',
        { userId, accountId },
        { jobId: `sync-${accountId}`, removeOnComplete: 100, removeOnFail: 250 },
      ),
    );
  }

  async enqueueQuotaRefresh(userId: string): Promise<boolean> {
    return this.enqueue(QUOTA_REFRESH_QUEUE, (queue) =>
      queue.add('refresh-quota', { userId }, { removeOnComplete: 100, removeOnFail: 250 }),
    );
  }

  async enqueueTokenRefresh(accountId: string): Promise<boolean> {
    return this.enqueue(TOKEN_REFRESH_QUEUE, (queue) =>
      queue.add('refresh-token', { accountId }, { attempts: 3, backoff: { type: 'exponential', delay: 30000 } }),
    );
  }

  async enqueueUploadVerification(userId: string, sessionId: string, driveFileId: string, bytesUploaded: string): Promise<boolean> {
    return this.enqueue(UPLOAD_VERIFY_QUEUE, (queue) =>
      queue.add(
        'verify-upload',
        { userId, sessionId, driveFileId, bytesUploaded },
        { attempts: 3, backoff: { type: 'exponential', delay: 15000 }, removeOnComplete: 100, removeOnFail: 250 },
      ),
    );
  }

  async enqueueMoveFile(operationId: string): Promise<boolean> {
    return this.enqueue(MOVE_FILE_QUEUE, (queue) =>
      queue.add(
        'move-file',
        { operationId },
        {
          jobId: `move-${operationId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 30000 },
          removeOnComplete: 100,
          removeOnFail: 250,
        },
      ),
    );
  }

  async enqueueDuplicateScan(userId: string, delay = 0): Promise<boolean> {
    return this.enqueue(DUPLICATE_SCAN_QUEUE, (queue) =>
      queue.add(
        'scan-user',
        { userId },
        {
          jobId: `duplicate-scan-${userId}`,
          delay,
          attempts: 2,
          backoff: { type: 'exponential', delay: 60000 },
          removeOnComplete: 100,
          removeOnFail: 250,
        },
      ),
    );
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  private async enqueue(name: string, addJob: (queue: Queue) => Promise<unknown>): Promise<boolean> {
    const queue = this.getQueue(name);
    if (!queue) return false;

    try {
      await addJob(queue);
      return true;
    } catch (error) {
      this.logger.warn(`Queue "${name}" enqueue failed; falling back to inline behavior: ${this.errorMessage(error)}`);
      return false;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
