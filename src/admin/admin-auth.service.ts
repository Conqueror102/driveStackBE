import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Admin, AuditAction } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminLoginDto } from './dto/admin-login.dto';

type SafeAdmin = Omit<Admin, 'passwordHash'>;

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: AdminLoginDto, context?: { ipAddress?: string; userAgent?: string }) {
    const admin = await this.prisma.admin.findUnique({ where: { email: dto.email } });
    if (!admin || !(await bcrypt.compare(dto.password, admin.passwordHash))) {
      throw new UnauthorizedException('Invalid admin credentials');
    }

    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });
    await this.audit.log({
      adminId: admin.id,
      action: AuditAction.ADMIN_LOGIN,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });

    return this.issueToken(admin);
  }

  async logout(adminId: string, context?: { ipAddress?: string; userAgent?: string }) {
    await this.prisma.admin.update({
      where: { id: adminId },
      data: { tokenVersion: { increment: 1 } },
    });
    await this.audit.log({
      adminId,
      action: AuditAction.ADMIN_LOGOUT,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return { success: true };
  }

  me(admin: Admin): SafeAdmin {
    const { passwordHash: _passwordHash, ...safeAdmin } = admin;
    return safeAdmin;
  }

  private issueToken(admin: Admin) {
    const token = this.jwt.sign(
      { sub: admin.id, email: admin.email, tokenVersion: admin.tokenVersion, type: 'admin' },
      { expiresIn: this.config.get<string>('JWT_EXPIRES_IN') || '7d' },
    );
    return { token, admin: this.me(admin) };
  }
}
