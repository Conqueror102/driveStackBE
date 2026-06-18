import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { GoogleAccountsController } from './google-accounts.controller';
import { GoogleAccountsService } from './google-accounts.service';
import { GoogleAuthService } from './google-auth.service';
import { TokenRefreshProcessor } from './token-refresh.processor';

@Module({
  imports: [DriveModule, SubscriptionsModule],
  controllers: [GoogleAccountsController],
  providers: [GoogleAccountsService, GoogleAuthService, TokenRefreshProcessor],
  exports: [GoogleAccountsService, GoogleAuthService],
})
export class GoogleAccountsModule {}
