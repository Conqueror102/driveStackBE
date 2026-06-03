import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  imports: [DriveModule],
  controllers: [StorageController],
  providers: [StorageService],
})
export class StorageModule {}
