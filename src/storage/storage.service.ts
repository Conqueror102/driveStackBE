import { Injectable } from '@nestjs/common';
import { AccountStatus } from '@prisma/client';
import { QuotaService } from '../drive/quota.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';

const QUOTA_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class StorageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotaService: QuotaService,
    private readonly queue: QueueService,
    private readonly featureGuard: FeatureGuardService,
  ) {}

  async getSummary(userId: string, fileSize?: number) {
    const accounts = await this.prisma.connectedAccount.findMany({ where: { userId } });
    const cacheFresh = accounts.every(
      (account) => account.quotaUpdatedAt.getTime() > Date.now() - QUOTA_TTL_MS,
    );

    if (!cacheFresh) {
      const queued = await this.queue.enqueueQuotaRefresh(userId);
      if (queued && accounts.length > 0) {
        const mapped = accounts.map((account) => ({
          accountId: account.id,
          googleEmail: account.googleEmail,
          limit: account.storageLimit,
          used: account.storageUsed,
          free: account.storageLimit - account.storageUsed,
          isDefault: account.isDefault,
          status: account.status,
          quotaUpdatedAt: account.quotaUpdatedAt,
        }));
        const totalLimit = mapped.reduce((sum, account) => sum + account.limit, 0n);
        const totalUsed = mapped.reduce((sum, account) => sum + account.used, 0n);
        return {
          totalLimit,
          totalUsed,
          totalFree: totalLimit - totalUsed,
          recommendedAccountId: this.getRecommendedAccountId(mapped, fileSize),
          refreshQueued: true,
          accounts: mapped,
        };
      }
      const quota = await this.quotaService.getAggregatedQuota(userId);
      const mapped = quota.perAccount.map((account) => ({
        ...account,
        isDefault: accounts.find((item) => item.id === account.accountId)?.isDefault ?? false,
      }));
      return {
        totalLimit: quota.totalLimit,
        totalUsed: quota.totalUsed,
        totalFree: quota.totalFree,
        recommendedAccountId: this.getRecommendedAccountId(mapped, fileSize),
        accounts: mapped,
      };
    }

    const mapped = accounts.map((account) => ({
      accountId: account.id,
      googleEmail: account.googleEmail,
      limit: account.storageLimit,
      used: account.storageUsed,
      free: account.storageLimit - account.storageUsed,
      isDefault: account.isDefault,
      status: account.status,
      quotaUpdatedAt: account.quotaUpdatedAt,
    }));
    const totalLimit = mapped.reduce((sum, account) => sum + account.limit, 0n);
    const totalUsed = mapped.reduce((sum, account) => sum + account.used, 0n);
    return {
      totalLimit,
      totalUsed,
      totalFree: totalLimit - totalUsed,
      recommendedAccountId: this.getRecommendedAccountId(mapped, fileSize),
      accounts: mapped,
    };
  }

  async getHistory(userId: string, days: number) {
    await this.featureGuard.requireFeature(userId, 'storage_history');
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const accounts = await this.prisma.connectedAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        googleEmail: true,
        displayName: true,
        storageLimit: true,
        storageUsed: true,
        isDefault: true,
      },
    });
    const accountIds = accounts.map((account) => account.id);
    const snapshots = accountIds.length
      ? await this.prisma.storageSnapshot.findMany({
          where: { accountId: { in: accountIds }, takenAt: { gte: cutoff } },
          orderBy: [{ takenAt: 'asc' }, { accountId: 'asc' }],
        })
      : [];

    return {
      days,
      accounts,
      snapshots,
    };
  }

  private getRecommendedAccountId(
    accounts: Array<{
      accountId: string;
      free: bigint;
      isDefault?: boolean;
      status?: AccountStatus;
    }>,
    fileSize?: number,
  ): string | null {
    if (!fileSize) return null;
    const required = BigInt(fileSize);
    const eligible = accounts.filter((account) => account.free >= required && account.status !== 'REAUTH_REQUIRED');
    if (!eligible.length) return null;
    const defaultAccount = eligible.find((account) => account.isDefault);
    if (defaultAccount) return defaultAccount.accountId;
    return eligible.sort((a, b) => {
      if (a.free === b.free) return 0;
      return a.free > b.free ? -1 : 1;
    })[0].accountId;
  }
}
