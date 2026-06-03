import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { ConnectedAccount } from '@prisma/client';
import { Observable } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuditAction } from '@prisma/client';
import { QueueService } from '../../queue/queue.service';
import { GoogleAuthService } from '../../google-accounts/google-auth.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TokenRefreshInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TokenRefreshInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleAuth: GoogleAuthService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{ user?: { id: string } }>();
    const user = req.user;
    if (!user) return next.handle();

    const accounts = await this.prisma.connectedAccount.findMany({
      where: { userId: user.id },
    });

    await Promise.all(
      accounts.filter((account) => this.isExpiringSoon(account.expiresAt)).map((account) => this.refresh(account)),
    );

    return next.handle();
  }

  private isExpiringSoon(expiresAt: Date): boolean {
    const bufferMs = 5 * 60 * 1000;
    return new Date(expiresAt).getTime() - bufferMs < Date.now();
  }

  private async refresh(account: ConnectedAccount): Promise<void> {
    try {
      const plainRefreshToken = this.crypto.decrypt(account.refreshToken);
      const creds = await this.googleAuth.refreshAccessToken(plainRefreshToken);
      if (!creds.access_token || !creds.expiry_date) {
        return;
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
    } catch (error) {
      this.logger.warn(`Token refresh failed for account ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
      await this.queue.enqueueTokenRefresh(account.id);
      await this.prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          status: 'REAUTH_REQUIRED',
          reauthRequiredAt: new Date(),
          lastSyncError: 'Google token refresh failed',
        },
      });
      await this.audit.log({
        userId: account.userId,
        accountId: account.id,
        action: AuditAction.GOOGLE_ACCOUNT_REAUTH_REQUIRED,
      });
    }
  }
}
