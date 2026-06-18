import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AdminAuditService } from '../common/admin-audit/admin-audit.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  async getOrCreateReferralCode(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true, email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.referralCode) return user.referralCode;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = this.buildCode(user.email);
      try {
        await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
        return code;
      } catch {
        continue;
      }
    }
    throw new Error('Could not generate referral code');
  }

  async recordReferral(referralCode: string, newUserId: string, signupIp: string): Promise<void> {
    const referrer = await this.prisma.user.findUnique({ where: { referralCode } });
    if (!referrer || referrer.id === newUserId) return;

    const recentFromIp = await this.prisma.referral.count({
      where: {
        referredUser: { signupIp },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    await this.prisma.referral
      .create({
        data: {
          referrerId: referrer.id,
          referredUserId: newUserId,
          status: 'PENDING',
        },
      })
      .catch(() => undefined);

    if (recentFromIp >= 3) {
      await this.audit.log({
        userId: referrer.id,
        action: 'referral.suspicious_signup',
        entity: 'Referral',
        entityId: newUserId,
        metadata: { signupIp, recentFromIp },
      });
    }
  }

  async getStats(userId: string) {
    const code = await this.getOrCreateReferralCode(userId);
    const [referrals, user] = await Promise.all([
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        include: { referredUser: { select: { email: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { bonusSlots: true } }),
    ]);

    return {
      referralCode: code,
      referralUrl: `${this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000'}/signup?ref=${code}`,
      bonusSlots: user.bonusSlots,
      maxBonusSlots: 3,
      referrals: referrals.map((referral) => ({
        email: this.maskEmail(referral.referredUser.email),
        status: referral.status,
        joinedAt: referral.referredUser.createdAt,
        convertedAt: referral.convertedAt,
      })),
      totalPending: referrals.filter((referral) => referral.status === 'PENDING').length,
      totalConverted: referrals.filter((referral) => referral.status === 'CONVERTED').length,
    };
  }

  async expireStaleReferrals(): Promise<void> {
    await this.prisma.referral.updateMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      data: { status: 'EXPIRED' },
    });
  }

  private buildCode(email: string): string {
    const prefix = email.split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'USER';
    const random = randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}${random}`;
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
}
