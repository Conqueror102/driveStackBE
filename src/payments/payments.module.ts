import { Module } from '@nestjs/common';
import { AdminAuditModule } from '../common/admin-audit/admin-audit.module';
import { GeoModule } from '../common/geo/geo.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { DodoClient } from './dodo.client';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [AdminAuditModule, GeoModule, SubscriptionsModule],
  controllers: [PaymentsController, WebhookController],
  providers: [DodoClient, PaymentsService, WebhookService],
})
export class PaymentsModule {}
