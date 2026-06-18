import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { BulkMoveDto } from './dto/bulk-move.dto';
import { MoveService } from './move.service';

@UseGuards(JwtAuthGuard)
@Controller('files/bulk')
export class BulkMoveController {
  constructor(private readonly moveService: MoveService) {}

  @Post('move')
  move(@CurrentUser() user: SafeUser, @Body() dto: BulkMoveDto) {
    return this.moveService.bulkMove(user.id, dto);
  }
}
