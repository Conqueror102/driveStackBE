import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  DUPLICATE_SCAN_QUEUE,
  FILE_SYNC_QUEUE,
  MOVE_FILE_QUEUE,
  QUOTA_REFRESH_QUEUE,
  QueueService,
  TOKEN_REFRESH_QUEUE,
  UPLOAD_VERIFY_QUEUE,
} from '../queue/queue.service';

const ADMIN_QUEUE_NAMES = [
  FILE_SYNC_QUEUE,
  QUOTA_REFRESH_QUEUE,
  TOKEN_REFRESH_QUEUE,
  UPLOAD_VERIFY_QUEUE,
  MOVE_FILE_QUEUE,
  DUPLICATE_SCAN_QUEUE,
] as const;

type AdminQueueName = (typeof ADMIN_QUEUE_NAMES)[number];

@Injectable()
export class AdminJobsService {
  constructor(private readonly queueService: QueueService) {}

  async listQueues() {
    return Promise.all(
      ADMIN_QUEUE_NAMES.map(async (name) => {
        const queue = this.getQueueOrNull(name);
        if (!queue) {
          return { name, enabled: false };
        }
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
        return { name, enabled: true, counts };
      }),
    );
  }

  async listJobs(queueName: string, status = 'failed', start = 0, end = 49) {
    const queue = this.getQueue(queueName);
    const normalizedStatus = this.normalizeStatus(status);
    const jobs = await queue.getJobs([normalizedStatus], Number(start) || 0, Number(end) || 49, false);
    return {
      queueName,
      status: normalizedStatus,
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data,
        progress: job.progress,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
      })),
    };
  }

  async retry(queueName: string, jobId: string) {
    const job = await this.getJob(queueName, jobId);
    await job.retry();
    return { success: true };
  }

  async remove(queueName: string, jobId: string) {
    const job = await this.getJob(queueName, jobId);
    await job.remove();
    return { success: true };
  }

  private getQueueOrNull(queueName: AdminQueueName) {
    return this.queueService.getQueue(queueName);
  }

  private getQueue(queueName: string) {
    if (!ADMIN_QUEUE_NAMES.includes(queueName as AdminQueueName)) {
      throw new BadRequestException('Unknown queue');
    }
    const queue = this.queueService.getQueue(queueName);
    if (!queue) {
      throw new ServiceUnavailableException('Redis queueing is not enabled');
    }
    return queue;
  }

  private async getJob(queueName: string, jobId: string) {
    const queue = this.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    return job;
  }

  private normalizeStatus(status: string): 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' {
    if (['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'].includes(status)) {
      return status as 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused';
    }
    throw new BadRequestException('Unsupported job status');
  }
}
