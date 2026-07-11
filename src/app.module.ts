import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ActivityModule } from './activity/activity.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuditModule } from './common/audit/audit.module';
import { AdminAuditModule } from './common/admin-audit/admin-audit.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { GeoModule } from './common/geo/geo.module';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { DriveModule } from './drive/drive.module';
import { DuplicatesModule } from './duplicates/duplicates.module';
import { EmailModule } from './email/email.module';
import { FilesModule } from './files/files.module';
import { GoogleAccountsModule } from './google-accounts/google-accounts.module';
import { JobsModule } from './jobs/jobs.module';
import { MoveModule } from './move/move.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { ReferralsModule } from './referrals/referrals.module';
import { RedisModule } from './redis/redis.module';
import { SavedSearchesModule } from './saved-searches/saved-searches.module';
import { StorageModule } from './storage/storage.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    QueueModule,
    CryptoModule,
    AuditModule,
    AdminAuditModule,
    GeoModule,
    SubscriptionsModule,
    ReferralsModule,
    PaymentsModule,
    ActivityModule,
    AdminModule,
    NotificationsModule,
    AlertsModule,
    EmailModule,
    AuthModule,
    GoogleAccountsModule,
    DriveModule,
    FilesModule,
    DuplicatesModule,
    MoveModule,
    SavedSearchesModule,
    StorageModule,
    JobsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
