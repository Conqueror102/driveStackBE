import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { RedisService } from '../redis/redis.service';
import { FILE_SYNC_QUEUE, UPLOAD_VERIFY_QUEUE } from '../queue/queue.service';
import { FilesService } from './files.service';

@Injectable()
export class FilesQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly workers: Worker[] = [];

  constructor(
    private readonly redis: RedisService,
    private readonly filesService: FilesService,
  ) {}

  onModuleInit() {
    if (!this.redis.isEnabled()) return;
    this.workers.push(
      new Worker(
        FILE_SYNC_QUEUE,
        async (job: Job<{ userId: string; accountId: string }>) => {
          await this.filesService.syncAccount(job.data.userId, job.data.accountId);
        },
        { connection: this.redis.duplicate() as never, concurrency: 2 },
      ),
      new Worker(
        UPLOAD_VERIFY_QUEUE,
        async (job: Job<{ userId: string; sessionId: string; driveFileId: string; bytesUploaded: string }>) => {
          await this.filesService.verifyUpload(
            job.data.userId,
            job.data.sessionId,
            job.data.driveFileId,
            job.data.bytesUploaded,
          );
        },
        { connection: this.redis.duplicate() as never, concurrency: 4 },
      ),
    );
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
