import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { DUPLICATE_SCAN_QUEUE } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { DuplicatesService } from './duplicates.service';

@Injectable()
export class DuplicatesQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly duplicatesService: DuplicatesService,
  ) {}

  onModuleInit() {
    if (!this.redis.isEnabled()) return;
    this.worker = new Worker(
      DUPLICATE_SCAN_QUEUE,
      async (job: Job<{ userId: string }>) => {
        await this.duplicatesService.runDuplicateScanForUser(job.data.userId);
      },
      { connection: this.redis.duplicate() as never, concurrency: 1 },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
