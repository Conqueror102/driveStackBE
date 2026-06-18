import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AlertsService } from './alerts.service';
import { CreateStorageAlertDto } from './dto/create-storage-alert.dto';

@UseGuards(JwtAuthGuard)
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  list(@CurrentUser() user: SafeUser) {
    return this.alertsService.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: SafeUser, @Body() dto: CreateStorageAlertDto) {
    return this.alertsService.create(user.id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: SafeUser, @Param('id') alertId: string) {
    return this.alertsService.remove(user.id, alertId);
  }
}
