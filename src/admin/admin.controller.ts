import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { Admin } from '@prisma/client';
import { AdminService } from './admin.service';
import { CurrentAdmin } from './current-admin.decorator';
import { ListAdminUsersQueryDto } from './dto/list-admin-users-query.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';

@UseGuards(AdminJwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('metrics/summary')
  summary() {
    return this.adminService.getSummary();
  }

  @Get('users')
  users(@Query() query: ListAdminUsersQueryDto) {
    return this.adminService.listUsers(query);
  }

  @Get('users/:id')
  user(@Param('id') userId: string) {
    return this.adminService.getUser(userId);
  }

  @Patch('users/:id/status')
  updateUserStatus(
    @CurrentAdmin() admin: Admin,
    @Param('id') userId: string,
    @Body() dto: UpdateUserStatusDto,
  ) {
    this.adminService.assertCanChangeUsers(admin);
    return this.adminService.updateUserStatus(admin, userId, dto.status);
  }

  @Get('audit-logs')
  auditLogs(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.adminService.listAuditLogs({ page: Number(page) || 1, limit: Number(limit) || 50 });
  }
}
