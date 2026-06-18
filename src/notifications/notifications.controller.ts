import { Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: SafeUser, @Query('read') read?: 'all' | 'read' | 'unread') {
    return this.notificationsService.list(user.id, read ?? 'unread');
  }

  @Get('count')
  count(@CurrentUser() user: SafeUser) {
    return this.notificationsService.count(user.id);
  }

  @Patch(':id/read')
  markRead(@CurrentUser() user: SafeUser, @Param('id') notificationId: string) {
    return this.notificationsService.markRead(user.id, notificationId);
  }

  @Patch('read-all')
  markAllRead(@CurrentUser() user: SafeUser) {
    return this.notificationsService.markAllRead(user.id);
  }
}
