import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ActivityModule } from '../activity/activity.module';
import { CryptoModule } from '../common/crypto/crypto.module';
import { DriveModule } from '../drive/drive.module';
import { DuplicatesModule } from '../duplicates/duplicates.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { BulkMoveController } from './bulk-move.controller';
import { MoveController } from './move.controller';
import { MoveGateway } from './move.gateway';
import { MoveQueueProcessor } from './move-queue.processor';
import { MoveService } from './move.service';

@Module({
  imports: [
    CryptoModule,
    ActivityModule,
    DriveModule,
    DuplicatesModule,
    NotificationsModule,
    SubscriptionsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [MoveController, BulkMoveController],
  providers: [MoveService, MoveGateway, MoveQueueProcessor],
  exports: [MoveService],
})
export class MoveModule {}
