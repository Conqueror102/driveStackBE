import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Admin } from '@prisma/client';
import { Request } from 'express';
import { AdminAuthService } from './admin-auth.service';
import { CurrentAdmin } from './current-admin.decorator';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminJwtAuthGuard } from './guards/admin-jwt-auth.guard';

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuth: AdminAuthService) {}

  @Post('login')
  login(@Body() dto: AdminLoginDto, @Req() req: Request) {
    return this.adminAuth.login(dto, this.requestContext(req));
  }

  @UseGuards(AdminJwtAuthGuard)
  @Get('me')
  me(@CurrentAdmin() admin: Admin) {
    return this.adminAuth.me(admin);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Post('logout')
  logout(@CurrentAdmin() admin: Admin, @Req() req: Request) {
    return this.adminAuth.logout(admin.id, this.requestContext(req));
  }

  private requestContext(req: Request) {
    return {
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.get('user-agent'),
    };
  }
}
