import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SafeUser } from '../auth/auth.service';
import { StorageService } from './storage.service';

@UseGuards(JwtAuthGuard)
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Get('summary')
  summary(@CurrentUser() user: SafeUser) {
    return this.storageService.getSummary(user.id);
  }
}
