import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CleanupService {
  constructor(private readonly prisma: PrismaService) {}

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
}
