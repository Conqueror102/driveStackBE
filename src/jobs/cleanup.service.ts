import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ActivityEventType, NotificationType } from '@prisma/client';
import { ActivityService } from '../activity/activity.service';
import { AdminAuditService } from '../common/admin-audit/admin-audit.service';
import { DuplicatesService } from '../duplicates/duplicates.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { ReferralsService } from '../referrals/referrals.service';

@Injectable()
export class CleanupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly duplicates: DuplicatesService,
    private readonly referrals: ReferralsService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  @Cron('0 * * * *')
  async expireUploadSessions() {
    await this.prisma.uploadSession.updateMany({
      where: {
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
  }

  @Cron('0 2 * * *')
  async pruneOldFileCacheEntries() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await this.prisma.fileCache.deleteMany({
      where: { cachedAt: { lt: cutoff } },
    });
  }

  @Cron('*/15 * * * *')
  async pruneExpiredOAuthStates() {
    await this.prisma.oAuthState.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }],
      },
    });
  }

  @Cron('0 */6 * * *')
  async checkStorageAlerts() {
    const accounts = await this.prisma.connectedAccount.findMany({
      where: { storageAlerts: { some: {} } },
      include: { storageAlerts: true },
    });

    for (const account of accounts) {
      if (account.storageLimit <= 0n) continue;
      const usedPct = (Number(account.storageUsed) / Number(account.storageLimit)) * 100;

      for (const alert of account.storageAlerts) {
        if (usedPct >= alert.threshold && !alert.triggered) {
          await this.notifications.create(
            account.userId,
            NotificationType.STORAGE_ALERT,
            `${account.googleEmail} is ${Math.round(usedPct)}% full`,
          );
          await this.activity.create({
            userId: account.userId,
            type: ActivityEventType.STORAGE_ALERT,
            message: `${account.googleEmail} is ${Math.round(usedPct)}% full`,
            accountId: account.id,
            metadata: { threshold: alert.threshold, usedPct: Math.round(usedPct) },
          });
          await this.prisma.storageAlert.update({
            where: { id: alert.id },
            data: { triggered: true, sentAt: new Date() },
          });
        }

        if (usedPct < alert.threshold && alert.triggered) {
          await this.prisma.storageAlert.update({
            where: { id: alert.id },
            data: { triggered: false },
          });
        }
      }
    }
  }

  @Cron('5 0 * * *')
  async takeStorageSnapshot() {
    // Use cursor-based pagination to avoid loading all accounts into memory at once
    const BATCH_SIZE = 1000;
    let cursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const accounts = await this.prisma.connectedAccount.findMany({
        select: { id: true, storageUsed: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (accounts.length === 0) break;

      await this.prisma.storageSnapshot.createMany({
        data: accounts.map((account) => ({
          accountId: account.id,
          usedBytes: account.storageUsed,
        })),
      });

      cursor = accounts[accounts.length - 1].id;
      if (accounts.length < BATCH_SIZE) break;
    }

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await this.prisma.storageSnapshot.deleteMany({
      where: { takenAt: { lt: cutoff } },
    });
  }

  @Cron('15 0 * * *')
  async computeDuplicates() {
    // Use cursor-based pagination to avoid loading all users into memory at once
    const BATCH_SIZE = 500;
    let cursor: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const users = await this.prisma.user.findMany({
        where: { connectedAccounts: { some: {} } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (users.length === 0) break;

      for (const user of users) {
        const queued = await this.queue.enqueueDuplicateScan(user.id);
        if (!queued) {
          await this.duplicates.runDuplicateScanForUser(user.id);
        }
      }

      cursor = users[users.length - 1].id;
      if (users.length < BATCH_SIZE) break;
    }
  }

  @Cron('0 1 * * *')
  async expireReferrals() {
    await this.referrals.expireStaleReferrals();
  }

  @Cron('0 * * * *')
  async checkGracePeriods() {
    const expired = await this.prisma.subscription.findMany({
      where: {
        status: 'ON_HOLD',
        gracePeriodEndsAt: { lt: new Date() },
      },
    });

    for (const sub of expired) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { plan: 'FREE', status: 'EXPIRED' },
      });
      await this.adminAudit.log({
        userId: sub.userId,
        action: 'subscription.grace_period_expired',
        entity: 'Subscription',
        entityId: sub.id,
      });
    }
  }

  @Cron('0 2 * * *')
  async expireCancelledSubscriptions() {
    await this.prisma.subscription.updateMany({
      where: {
        status: 'CANCELLED',
        currentPeriodEnd: { lt: new Date() },
      },
      data: { plan: 'FREE', status: 'EXPIRED' },
    });
  }

  @Cron('0 3 * * 0')
  async cleanProcessedWebhooks() {
    await this.prisma.processedWebhook.deleteMany({
      where: {
        processedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });
  }
}
