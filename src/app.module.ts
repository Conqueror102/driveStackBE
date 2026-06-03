import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './common/audit/audit.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { RequestLoggingInterceptor } from './common/interceptors/request-logging.interceptor';
import { TokenRefreshInterceptor } from './common/interceptors/token-refresh.interceptor';
import { DriveModule } from './drive/drive.module';
import { EmailModule } from './email/email.module';
import { FilesModule } from './files/files.module';
import { GoogleAccountsModule } from './google-accounts/google-accounts.module';
import { JobsModule } from './jobs/jobs.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RedisModule,
    QueueModule,
    CryptoModule,
    AuditModule,
    AdminModule,
    EmailModule,
    AuthModule,
    GoogleAccountsModule,
    DriveModule,
    FilesModule,
    StorageModule,
    JobsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TokenRefreshInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
