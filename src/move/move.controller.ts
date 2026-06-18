import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MoveFileDto } from './dto/move-file.dto';
import { MoveService } from './move.service';

@UseGuards(JwtAuthGuard)
@Controller('files/move')
export class MoveController {
  constructor(private readonly moveService: MoveService) {}

  @Post()
  moveFile(@CurrentUser() user: SafeUser, @Body() dto: MoveFileDto) {
    return this.moveService.initiate(user.id, dto);
  }

  @Get('history')
  history(@CurrentUser() user: SafeUser, @Query('page') page?: number, @Query('limit') limit?: number) {
    return this.moveService.history(user.id, Number(page) || 1, Number(limit) || 50);
  }

  @Get(':operationId')
  getStatus(@CurrentUser() user: SafeUser, @Param('operationId') operationId: string) {
    return this.moveService.getStatus(user.id, operationId);
  }
}
