import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { MoveModule } from '../move/move.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { RebalanceService } from './rebalance.service';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  imports: [DriveModule, MoveModule, SubscriptionsModule],
  controllers: [StorageController],
  providers: [StorageService, RebalanceService],
})
export class StorageModule {}
