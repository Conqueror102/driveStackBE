import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { MOVE_FILE_QUEUE } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { MoveService } from './move.service';

@Injectable()
export class MoveQueueProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly moveService: MoveService,
  ) {}

  onModuleInit() {
    if (!this.redis.isEnabled()) return;
    this.worker = new Worker(
      MOVE_FILE_QUEUE,
      async (job: Job<{ operationId: string }>) => {
        await this.moveService.processMove(job.data.operationId, true);
      },
      { connection: this.redis.duplicate() as never, concurrency: 3 },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
