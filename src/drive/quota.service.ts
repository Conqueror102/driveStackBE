import { Injectable, Logger } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { DriveService } from './drive.service';

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly driveService: DriveService,
    private readonly audit: AuditService,
  ) {}

  async getAggregatedQuota(userId: string) {
    const accounts = await this.prisma.connectedAccount.findMany({ where: { userId } });

    const perAccount = await Promise.all(
      accounts.map(async (account) => {
        try {
          const quota = await this.driveService.getQuota(this.crypto.decrypt(account.accessToken));
          await this.prisma.connectedAccount.update({
            where: { id: account.id },
            data: {
              storageLimit: quota.limit,
              storageUsed: quota.usage,
              quotaUpdatedAt: new Date(),
              status: 'ACTIVE',
              lastSyncError: null,
            },
          });
          await this.audit.log({
            userId,
            accountId: account.id,
            action: AuditAction.QUOTA_REFRESHED,
            metadata: { limit: quota.limit.toString(), used: quota.usage.toString() },
          });
          return {
            accountId: account.id,
            googleEmail: account.googleEmail,
            limit: quota.limit,
            used: quota.usage,
            free: quota.limit - quota.usage,
          };
        } catch (error) {
          this.logger.warn(`Quota refresh failed for account ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
          await this.prisma.connectedAccount.update({
            where: { id: account.id },
            data: {
              status: 'SYNC_FAILED',
              lastSyncError: error instanceof Error ? error.message : 'Quota refresh failed',
            },
          });
          return {
            accountId: account.id,
            googleEmail: account.googleEmail,
            limit: 0n,
            used: 0n,
            free: 0n,
          };
        }
      }),
    );

    const totalLimit = perAccount.reduce((sum, account) => sum + account.limit, 0n);
    const totalUsed = perAccount.reduce((sum, account) => sum + account.used, 0n);
    return {
      totalLimit,
      totalUsed,
      totalFree: totalLimit - totalUsed,
      perAccount,
    };
  }
}
