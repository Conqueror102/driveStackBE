import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DriveModule } from '../drive/drive.module';
import { FilesController } from './files.controller';
import { FilesQueueProcessor } from './files-queue.processor';
import { FilesService } from './files.service';

@Module({
  imports: [ConfigModule, DriveModule],
  controllers: [FilesController],
  providers: [FilesService, FilesQueueProcessor],
})
export class FilesModule {}
