import { BadRequestException, ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuditAction, AuthTokenType, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { AuditService } from '../common/audit/audit.service';
import { AdminAuditService } from '../common/admin-audit/admin-audit.service';
import { GeoService } from '../common/geo/geo.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReferralsService } from '../referrals/referrals.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

export type SafeUser = Omit<User, 'passwordHash'>;

export function stripPasswordHash(user: User): SafeUser {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly audit: AuditService,
    private readonly adminAudit: AdminAuditService,
    private readonly email: EmailService,
    private readonly geo: GeoService,
    private readonly referrals: ReferralsService,
  ) {}

  async register(dto: RegisterDto, context?: { ipAddress?: string; userAgent?: string }) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const country = await this.geo.detectCountry(context?.ipAddress || '127.0.0.1');
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          displayName: dto.displayName,
          country,
          signupIp: context?.ipAddress,
          referralCode: this.generateReferralCode(dto.email),
        },
      });
      await tx.subscription.create({
        data: {
          userId: created.id,
          plan: 'FREE',
          status: 'ACTIVE',
        },
      });
      return created;
    });
    if (dto.referralCode) {
      await this.referrals.recordReferral(dto.referralCode, user.id, context?.ipAddress || '127.0.0.1');
    }
    await this.audit.log({
      userId: user.id,
      action: AuditAction.USER_REGISTERED,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      metadata: { country },
    });
    await this.adminAudit.log({
      userId: user.id,
      action: 'user.registered',
      entity: 'User',
      entityId: user.id,
      metadata: { country, ip: context?.ipAddress },
    });

    if (this.isProduction()) {
      const token = await this.createAuthToken(user.id, AuthTokenType.EMAIL_VERIFICATION, 24 * 60 * 60 * 1000);
      await this.email.sendEmailVerification(user.email, token);
      this.logger.log(`Production signup verification email sent for user ${user.id}`);
      await this.audit.log({
        userId: user.id,
        action: AuditAction.EMAIL_VERIFICATION_REQUESTED,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
      });
    }

    return this.issueToken(stripPasswordHash(user));
  }

  async requestEmailVerification(userId: string, context?: { ipAddress?: string; userAgent?: string }) {
    const token = await this.createAuthToken(userId, AuthTokenType.EMAIL_VERIFICATION, 24 * 60 * 60 * 1000);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.email.sendEmailVerification(user.email, token);
    this.logger.log(`Email verification requested for user ${userId}`);
    await this.audit.log({
      userId,
      action: AuditAction.EMAIL_VERIFICATION_REQUESTED,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return this.tokenResponse(token);
  }

  async verifyEmail(token: string, context?: { ipAddress?: string; userAgent?: string }) {
    const authToken = await this.consumeAuthToken(token, AuthTokenType.EMAIL_VERIFICATION);
    await this.prisma.user.update({
      where: { id: authToken.userId },
      data: { emailVerified: true },
    });
    await this.audit.log({
      userId: authToken.userId,
      action: AuditAction.EMAIL_VERIFIED,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return { success: true };
  }

  async requestPasswordReset(email: string, context?: { ipAddress?: string; userAgent?: string }) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      return { success: true };
    }
    const token = await this.createAuthToken(user.id, AuthTokenType.PASSWORD_RESET, 60 * 60 * 1000);
    await this.email.sendPasswordReset(user.email, token);
    this.logger.log(`Password reset requested for user ${user.id}`);
    await this.audit.log({
      userId: user.id,
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return this.tokenResponse(token);
  }

  async resetPassword(token: string, password: string, context?: { ipAddress?: string; userAgent?: string }) {
    const authToken = await this.consumeAuthToken(token, AuthTokenType.PASSWORD_RESET);
    await this.prisma.user.update({
      where: { id: authToken.userId },
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        tokenVersion: { increment: 1 },
      },
    });
    await this.audit.log({
      userId: authToken.userId,
      action: AuditAction.PASSWORD_RESET_COMPLETED,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return { success: true };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, context?: { ipAddress?: string; userAgent?: string }) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Invalid current password');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(dto.newPassword, 12),
        tokenVersion: { increment: 1 },
      },
    });
    await this.audit.log({
      userId,
      action: AuditAction.PASSWORD_CHANGED,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return { success: true };
  }

  async login(user: SafeUser, context?: { ipAddress?: string; userAgent?: string }) {
    await this.audit.log({
      userId: user.id,
      action: AuditAction.USER_LOGIN,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return this.issueToken(user);
  }

  async logout(userId: string, context?: { ipAddress?: string; userAgent?: string }) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    await this.audit.log({
      userId,
      action: AuditAction.USER_LOGOUT,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });
    return { success: true };
  }

  async validateUser(email: string, password: string): Promise<SafeUser | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || user.status !== 'ACTIVE') {
      return null;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return null;
    }

    return stripPasswordHash(user);
  }

  async findMe(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { subscription: true } });
    if (!user) {
      throw new UnauthorizedException('Invalid token');
    }
    const safe = stripPasswordHash(user);
    return {
      ...safe,
      country: user.country ?? 'UNKNOWN',
      currency: this.geo.getCurrency(user.country ?? 'UNKNOWN'),
      bonusSlots: user.bonusSlots,
      referralCode: user.referralCode,
      subscription: {
        plan: user.subscription?.plan ?? 'FREE',
        status: user.subscription?.status ?? 'ACTIVE',
        currentPeriodEnd: user.subscription?.currentPeriodEnd ?? null,
        gracePeriodEndsAt: user.subscription?.gracePeriodEndsAt ?? null,
      },
    };
  }

  async updateCountry(userId: string, country: string, context?: { ipAddress?: string; userAgent?: string }) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { country: true } });
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { country },
      select: { country: true },
    });
    await this.adminAudit.log({
      userId,
      action: 'user.country_updated',
      entity: 'User',
      entityId: userId,
      before: { country: user.country },
      after: { country },
      ipAddress: context?.ipAddress,
    });
    return { country: updated.country, currency: this.geo.getCurrency(updated.country ?? 'UNKNOWN') };
  }

  private issueToken(user: SafeUser) {
    const token = this.jwtService.sign(
      { sub: user.id, email: user.email, tokenVersion: user.tokenVersion },
      { expiresIn: this.configService.get<string>('JWT_EXPIRES_IN') || '7d' },
    );
    return { token, user };
  }

  private async createAuthToken(userId: string, type: AuthTokenType, ttlMs: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.authToken.create({
      data: {
        userId,
        type,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return token;
  }

  private async consumeAuthToken(token: string, type: AuthTokenType) {
    const authToken = await this.prisma.authToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!authToken || authToken.type !== type || authToken.usedAt || authToken.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invalid or expired token');
    }
    return this.prisma.authToken.update({
      where: { id: authToken.id },
      data: { usedAt: new Date() },
    });
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private tokenResponse(token: string) {
    if (this.isProduction()) {
      return { success: true };
    }
    return { success: true, token };
  }

  private isProduction(): boolean {
    return this.configService.get<string>('NODE_ENV') === 'production';
  }

  private generateReferralCode(email: string): string {
    const prefix = email.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'USER';
    return `${prefix}${randomBytes(5).toString('hex').toUpperCase()}`;
  }
}
