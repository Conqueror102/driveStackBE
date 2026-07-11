import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SafeUser } from '../auth/auth.service';
import { RebalanceDto } from './dto/rebalance.dto';
import { StorageHistoryQueryDto } from './dto/storage-history-query.dto';
import { StorageSummaryQueryDto } from './dto/storage-summary-query.dto';
import { RebalanceService } from './rebalance.service';
import { StorageService } from './storage.service';

@UseGuards(JwtAuthGuard)
@Controller('storage')
export class StorageController {
  constructor(
    private readonly storageService: StorageService,
    private readonly rebalanceService: RebalanceService,
  ) {}

  @Get('summary')
  summary(@CurrentUser() user: SafeUser, @Query() query: StorageSummaryQueryDto) {
    return this.storageService.getSummary(user.id, query.fileSize);
  }

  @Get('history')
  history(@CurrentUser() user: SafeUser, @Query() query: StorageHistoryQueryDto) {
    return this.storageService.getHistory(user.id, query.days);
  }

  @Get('by-type')
  byType(@CurrentUser() user: SafeUser) {
    return this.storageService.getUsageByType(user.id);
  }

  // Dry-run: returns the proposed moves without executing them.
  @Post('rebalance/plan')
  rebalancePlan(@CurrentUser() user: SafeUser, @Body() dto: RebalanceDto) {
    return this.rebalanceService.plan(user.id, dto.targetPercent);
  }

  @Post('rebalance')
  rebalance(@CurrentUser() user: SafeUser, @Body() dto: RebalanceDto) {
    return this.rebalanceService.execute(user.id, dto.targetPercent);
  }
}
