import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { Job, Worker } from 'bullmq';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { TOKEN_REFRESH_QUEUE } from '../queue/queue.service';
import { RedisService } from '../redis/redis.service';
import { GoogleAuthService } from './google-auth.service';

@Injectable()
export class TokenRefreshProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly googleAuth: GoogleAuthService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    if (!this.redis.isEnabled()) return;
    this.worker = new Worker(
      TOKEN_REFRESH_QUEUE,
      async (job: Job<{ accountId: string }>) => {
        const account = await this.prisma.connectedAccount.findUnique({ where: { id: job.data.accountId } });
        if (!account) return;
        const creds = await this.googleAuth.refreshAccessToken(this.crypto.decrypt(account.refreshToken));
        if (!creds.access_token || !creds.expiry_date) {
          throw new Error('Google did not return refreshed access token');
        }
        await this.prisma.connectedAccount.update({
          where: { id: account.id },
          data: {
            accessToken: this.crypto.encrypt(creds.access_token),
            ...(creds.refresh_token ? { refreshToken: this.crypto.encrypt(creds.refresh_token) } : {}),
            expiresAt: new Date(creds.expiry_date),
            status: 'ACTIVE',
            reauthRequiredAt: null,
            lastSyncError: null,
          },
        });
        await this.audit.log({
          userId: account.userId,
          accountId: account.id,
          action: AuditAction.GOOGLE_ACCOUNT_REAUTHED,
        });
      },
      { connection: this.redis.duplicate() as never, concurrency: 2 },
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }
}
