import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { QUOTA_REFRESH_QUEUE } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { QuotaService } from './quota.service';

@Injectable()
export class DriveQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly quotaService: QuotaService,
  ) {}

  onModuleInit() {
    if (!this.redis.isEnabled()) return;
    this.worker = new Worker(
      QUOTA_REFRESH_QUEUE,
      async (job: Job<{ userId: string }>) => {
        await this.quotaService.getAggregatedQuota(job.data.userId);
      },
      { connection: this.redis.duplicate() as never, concurrency: 2 },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
