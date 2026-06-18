import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  imports: [DriveModule, SubscriptionsModule],
  controllers: [StorageController],
  providers: [StorageService],
})
export class StorageModule {}
