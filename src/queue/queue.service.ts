import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { RedisService } from '../redis/redis.service';

export const FILE_SYNC_QUEUE = 'file-sync';
export const QUOTA_REFRESH_QUEUE = 'quota-refresh';
export const TOKEN_REFRESH_QUEUE = 'token-refresh';
export const UPLOAD_VERIFY_QUEUE = 'upload-verify';

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly redis: RedisService) {}

  isEnabled(): boolean {
    return this.redis.isEnabled();
  }

  getQueue(name: string): Queue | null {
    if (!this.redis.isEnabled()) return null;
    const existing = this.queues.get(name);
    if (existing) return existing;
    const queue = new Queue(name, { connection: this.redis.duplicate() as never });
    this.queues.set(name, queue);
    return queue;
  }

  async enqueueFileSync(userId: string, accountId: string): Promise<boolean> {
    const queue = this.getQueue(FILE_SYNC_QUEUE);
    if (!queue) return false;
    await queue.add(
      'sync-account',
      { userId, accountId },
      { jobId: `sync-${accountId}`, removeOnComplete: 100, removeOnFail: 250 },
    );
    return true;
  }

  async enqueueQuotaRefresh(userId: string): Promise<boolean> {
    const queue = this.getQueue(QUOTA_REFRESH_QUEUE);
    if (!queue) return false;
    await queue.add('refresh-quota', { userId }, { removeOnComplete: 100, removeOnFail: 250 });
    return true;
  }

  async enqueueTokenRefresh(accountId: string): Promise<boolean> {
    const queue = this.getQueue(TOKEN_REFRESH_QUEUE);
    if (!queue) return false;
    await queue.add('refresh-token', { accountId }, { attempts: 3, backoff: { type: 'exponential', delay: 30000 } });
    return true;
  }

  async enqueueUploadVerification(userId: string, sessionId: string, driveFileId: string, bytesUploaded: string): Promise<boolean> {
    const queue = this.getQueue(UPLOAD_VERIFY_QUEUE);
    if (!queue) return false;
    await queue.add(
      'verify-upload',
      { userId, sessionId, driveFileId, bytesUploaded },
      { attempts: 3, backoff: { type: 'exponential', delay: 15000 }, removeOnComplete: 100, removeOnFail: 250 },
    );
    return true;
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
