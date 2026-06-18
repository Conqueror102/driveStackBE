import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Admin } from '@prisma/client';
import { Request } from 'express';
import { AdminService } from './admin.service';
import { CurrentAdmin } from './current-admin.decorator';
import { ListAdminUsersQueryDto } from './dto/list-admin-users-query.dto';
import { ManualUpgradeDto } from './dto/manual-upgrade.dto';
import { UpdatePricingDto } from './dto/update-pricing.dto';
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

  @Post('users/:id/upgrade')
  manualUpgrade(
    @CurrentAdmin() admin: Admin,
    @Param('id') userId: string,
    @Body() dto: ManualUpgradeDto,
    @Req() req: Request,
  ) {
    return this.adminService.manualUpgrade(admin, userId, dto.note || '', req.ip || req.socket.remoteAddress || '');
  }

  @Put('pricing')
  updatePricing(@CurrentAdmin() admin: Admin, @Body() dto: UpdatePricingDto, @Req() req: Request) {
    return this.adminService.updatePricing(admin, dto, req.ip || req.socket.remoteAddress || '');
  }

  @Get('payment-audit-log')
  paymentAuditLog(
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.adminService.getPaymentAuditLog({
      userId,
      action,
      page: Number(page) || 1,
      limit: Number(limit) || 50,
    });
  }

  @Get('revenue')
  revenue() {
    return this.adminService.getRevenueSummary();
  }
}
