import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { DuplicatesController } from './duplicates.controller';
import { DuplicatesQueueProcessor } from './duplicates-queue.processor';
import { DuplicatesService } from './duplicates.service';

@Module({
  imports: [ActivityModule, NotificationsModule, SubscriptionsModule],
  controllers: [DuplicatesController],
  providers: [DuplicatesService, DuplicatesQueueProcessor],
  exports: [DuplicatesService],
})
export class DuplicatesModule {}
