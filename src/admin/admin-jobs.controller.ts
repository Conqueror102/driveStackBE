import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJobsService } from './admin-jobs.service';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';

@UseGuards(AdminJwtAuthGuard)
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly adminJobsService: AdminJobsService) {}

  @Get('queues')
  queues() {
    return this.adminJobsService.listQueues();
  }

  @Get(':queueName')
  jobs(
    @Param('queueName') queueName: string,
    @Query('status') status?: string,
    @Query('start') start?: number,
    @Query('end') end?: number,
  ) {
    return this.adminJobsService.listJobs(queueName, status || 'failed', Number(start) || 0, Number(end) || 49);
  }

  @Post(':queueName/:jobId/retry')
  retry(@Param('queueName') queueName: string, @Param('jobId') jobId: string) {
    return this.adminJobsService.retry(queueName, jobId);
  }

  @Post(':queueName/:jobId/remove')
  remove(@Param('queueName') queueName: string, @Param('jobId') jobId: string) {
    return this.adminJobsService.remove(queueName, jobId);
  }
}
