import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { DuplicatesModule } from '../duplicates/duplicates.module';
import { GoogleAccountsModule } from '../google-accounts/google-accounts.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminAuditModule } from '../common/admin-audit/admin-audit.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { CleanupService } from './cleanup.service';

@Module({
  imports: [ActivityModule, AdminAuditModule, DuplicatesModule, GoogleAccountsModule, NotificationsModule, ReferralsModule],
  providers: [CleanupService],
})
export class JobsModule {}
