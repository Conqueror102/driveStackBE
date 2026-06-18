import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ActivityService } from './activity.service';
import { ListActivityQueryDto } from './dto/list-activity-query.dto';

@UseGuards(JwtAuthGuard)
@Controller('activity')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get()
  list(@CurrentUser() user: SafeUser, @Query() query: ListActivityQueryDto) {
    return this.activityService.list(user.id, query);
  }

  @Get('recent')
  recent(@CurrentUser() user: SafeUser) {
    return this.activityService.recent(user.id);
  }
}
