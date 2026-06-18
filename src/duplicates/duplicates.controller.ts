import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DuplicatesService } from './duplicates.service';

@UseGuards(JwtAuthGuard)
@Controller('files/duplicates')
export class DuplicatesController {
  constructor(private readonly duplicatesService: DuplicatesService) {}

  @Get()
  list(@CurrentUser() user: SafeUser) {
    return this.duplicatesService.list(user.id);
  }

  @Get('count')
  count(@CurrentUser() user: SafeUser) {
    return this.duplicatesService.count(user.id);
  }

  @Post('scan')
  scan(@CurrentUser() user: SafeUser) {
    return this.duplicatesService.triggerScan(user.id);
  }
}
