import { Module } from '@nestjs/common';
import { DriveQueueProcessor } from './drive-queue.processor';
import { DriveService } from './drive.service';
import { QuotaService } from './quota.service';

@Module({
  providers: [DriveService, QuotaService, DriveQueueProcessor],
  exports: [DriveService, QuotaService],
})
export class DriveModule {}
