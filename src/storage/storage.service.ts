import { Injectable } from '@nestjs/common';
import { QuotaService } from '../drive/quota.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';

const QUOTA_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class StorageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quotaService: QuotaService,
    private readonly queue: QueueService,
  ) {}

  async getSummary(userId: string) {
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
          status: account.status,
          quotaUpdatedAt: account.quotaUpdatedAt,
        }));
        const totalLimit = mapped.reduce((sum, account) => sum + account.limit, 0n);
        const totalUsed = mapped.reduce((sum, account) => sum + account.used, 0n);
        return {
          totalLimit,
          totalUsed,
          totalFree: totalLimit - totalUsed,
          refreshQueued: true,
          accounts: mapped,
        };
      }
      const quota = await this.quotaService.getAggregatedQuota(userId);
      return {
        totalLimit: quota.totalLimit,
        totalUsed: quota.totalUsed,
        totalFree: quota.totalFree,
        accounts: quota.perAccount,
      };
    }

    const mapped = accounts.map((account) => ({
      accountId: account.id,
      googleEmail: account.googleEmail,
      limit: account.storageLimit,
      used: account.storageUsed,
      free: account.storageLimit - account.storageUsed,
    }));
    const totalLimit = mapped.reduce((sum, account) => sum + account.limit, 0n);
    const totalUsed = mapped.reduce((sum, account) => sum + account.used, 0n);
    return {
      totalLimit,
      totalUsed,
      totalFree: totalLimit - totalUsed,
      accounts: mapped,
    };
  }
}
