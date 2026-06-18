import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });
    if (!user) throw new UnauthorizedException('Invalid token');
    return {
      plan: user.subscription?.plan ?? 'FREE',
      status: user.subscription?.status ?? 'ACTIVE',
      currentPeriodEnd: user.subscription?.currentPeriodEnd ?? null,
      gracePeriodEndsAt: user.subscription?.gracePeriodEndsAt ?? null,
      bonusSlots: user.bonusSlots,
    };
  }
}
