import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const PRO_FEATURES = [
  'move_files',
  'duplicate_detector',
  'bulk_operations',
  'storage_alerts',
  'storage_history',
  'upload_from_url',
  'file_preview',
  'connect_account_above_limit',
] as const;

export type ProFeature = (typeof PRO_FEATURES)[number];

@Injectable()
export class FeatureGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async canAccess(userId: string, feature: ProFeature): Promise<boolean> {
    void feature;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });
    if (!user) return false;

    const isPro = user.subscription?.plan === 'PRO';
    const isActive = user.subscription?.status === 'ACTIVE';
    const isOnHold = user.subscription?.status === 'ON_HOLD';
    if (isPro && (isActive || isOnHold)) return true;

    if (isPro && user.subscription?.status === 'CANCELLED') {
      const periodEnd = user.subscription.currentPeriodEnd;
      if (periodEnd && periodEnd > new Date()) return true;
    }

    return false;
  }

  async requireFeature(userId: string, feature: ProFeature): Promise<void> {
    if (await this.canAccess(userId, feature)) return;
    throw new ForbiddenException({
      code: 'FEATURE_LOCKED',
      feature,
      message: 'This feature requires a Pro subscription',
      upgradeUrl: '/pricing',
    });
  }

  async getAccountLimit(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });
    if (!user) return 2;
    if (await this.canAccess(userId, 'connect_account_above_limit')) return Number.MAX_SAFE_INTEGER;
    return 2 + (user.bonusSlots ?? 0);
  }
}
