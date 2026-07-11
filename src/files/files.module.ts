import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActivityModule } from '../activity/activity.module';
import { DriveModule } from '../drive/drive.module';
import { GoogleAccountsModule } from '../google-accounts/google-accounts.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { FilesController } from './files.controller';
import { FilesQueueProcessor } from './files-queue.processor';
import { FilesService } from './files.service';

@Module({
  imports: [ConfigModule, DriveModule, ActivityModule, GoogleAccountsModule, SubscriptionsModule],
  controllers: [FilesController],
  providers: [FilesService, FilesQueueProcessor],
  exports: [FilesService],
})
export class FilesModule {}
