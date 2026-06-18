import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';
import { CreateStorageAlertDto } from './dto/create-storage-alert.dto';

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureGuard: FeatureGuardService,
  ) {}

  list(userId: string) {
    return this.prisma.storageAlert.findMany({
      where: { userId },
      orderBy: [{ accountId: 'asc' }, { threshold: 'asc' }],
      include: {
        account: {
          select: {
            id: true,
            googleEmail: true,
            displayName: true,
            storageLimit: true,
            storageUsed: true,
          },
        },
      },
    });
  }

  async create(userId: string, dto: CreateStorageAlertDto) {
    await this.featureGuard.requireFeature(userId, 'storage_alerts');
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: dto.accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    return this.prisma.storageAlert.upsert({
      where: { accountId_threshold: { accountId: dto.accountId, threshold: dto.threshold } },
      update: {},
      create: {
        userId,
        accountId: dto.accountId,
        threshold: dto.threshold,
      },
    });
  }

  async remove(userId: string, alertId: string) {
    const alert = await this.prisma.storageAlert.findUnique({ where: { id: alertId } });
    if (!alert) {
      throw new NotFoundException('Storage alert not found');
    }
    if (alert.userId !== userId) {
      throw new ForbiddenException('Storage alert does not belong to user');
    }
    await this.prisma.storageAlert.delete({ where: { id: alertId } });
    return { success: true };
  }
}
