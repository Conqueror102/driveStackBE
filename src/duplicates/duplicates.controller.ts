import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ResolveAllDto, ResolveGroupDto } from './dto/resolve-duplicates.dto';
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

  @Post('resolve-all')
  resolveAll(@CurrentUser() user: SafeUser, @Body() dto: ResolveAllDto) {
    return this.duplicatesService.resolveAll(user.id, dto.strategy);
  }

  @Post(':groupId/resolve')
  resolve(
    @CurrentUser() user: SafeUser,
    @Param('groupId') groupId: string,
    @Body() dto: ResolveGroupDto,
  ) {
    return this.duplicatesService.resolveGroup(user.id, groupId, dto.keepFileId);
  }
}
