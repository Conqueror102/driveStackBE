import { Module } from '@nestjs/common';
import { FeatureGuardService } from './feature-guard.service';
import { SubscriptionsService } from './subscriptions.service';

@Module({
  providers: [FeatureGuardService, SubscriptionsService],
  exports: [FeatureGuardService, SubscriptionsService],
})
export class SubscriptionsModule {}
