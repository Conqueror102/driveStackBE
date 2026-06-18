import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SafeUser } from '../auth/auth.service';
import { StorageHistoryQueryDto } from './dto/storage-history-query.dto';
import { StorageSummaryQueryDto } from './dto/storage-summary-query.dto';
import { StorageService } from './storage.service';

@UseGuards(JwtAuthGuard)
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Get('summary')
  summary(@CurrentUser() user: SafeUser, @Query() query: StorageSummaryQueryDto) {
    return this.storageService.getSummary(user.id, query.fileSize);
  }

  @Get('history')
  history(@CurrentUser() user: SafeUser, @Query() query: StorageHistoryQueryDto) {
    return this.storageService.getHistory(user.id, query.days);
  }
}
