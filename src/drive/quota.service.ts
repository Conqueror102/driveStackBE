import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, ConnectedAccount } from '@prisma/client';
import { google } from 'googleapis';
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
    private readonly configService: ConfigService,
  ) {}

  async getAggregatedQuota(userId: string) {
    const accounts = await this.prisma.connectedAccount.findMany({ where: { userId } });

    const perAccount = await Promise.all(
      accounts.map(async (account) => {
        try {
          const quota = await this.getQuotaWithRefresh(account, userId);
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

  private async getQuotaWithRefresh(account: ConnectedAccount, userId: string) {
    // If account already needs re-auth, don't bother trying — surface immediately
    if (account.status === 'REAUTH_REQUIRED') {
      throw new ForbiddenException(
        `Google account ${account.googleEmail} requires re-authentication. Please reconnect the account.`,
      );
    }

    try {
      return await this.driveService.getQuota(this.crypto.decrypt(account.accessToken));
    } catch (error) {
      if (!account.refreshToken || !this.isTokenError(error)) {
        throw error;
      }

      // Token is expired/invalid — attempt a refresh
      const refreshed = await this.refreshAccountTokens(account);
      if (!refreshed) {
        // Token refresh itself failed (revoked refresh token, etc.)
        throw new ForbiddenException(
          `Google account ${account.googleEmail} requires re-authentication. Token refresh failed.`,
        );
      }

      // Refresh succeeded — retry the Drive call with the new token
      const updatedAccount = await this.prisma.connectedAccount.findUnique({ where: { id: account.id } });
      if (!updatedAccount) {
        throw new Error('Connected account not found after token refresh');
      }

      try {
        return await this.driveService.getQuota(this.crypto.decrypt(updatedAccount.accessToken));
      } catch (retryError) {
        // Refresh succeeded but Drive still rejects us — the user likely
        // revoked the Drive scope or the API is not enabled. Mark as REAUTH_REQUIRED
        // so we stop hammering Google on every subsequent call.
        this.logger.warn(
          `Drive API still forbidden after token refresh for account ${account.id} (${account.googleEmail}). ` +
          `The Drive scope was likely revoked. Marking as REAUTH_REQUIRED.`,
        );
        await this.markReauthRequired(
          account,
          'Drive access forbidden after token refresh — the Drive scope may have been revoked. Please reconnect this Google account.',
        );
        throw new ForbiddenException(
          `Google account ${account.googleEmail} requires re-authentication. Drive scope may have been revoked.`,
        );
      }
    }
  }

  private createOAuthClient() {
    return new google.auth.OAuth2(
      this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      this.configService.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      this.configService.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
    );
  }

  private async refreshAccountTokens(account: ConnectedAccount): Promise<boolean> {
    try {
      const auth = this.createOAuthClient();
      auth.setCredentials({ refresh_token: this.crypto.decrypt(account.refreshToken) });
      const { credentials } = await auth.refreshAccessToken();

      if (!credentials.access_token || !credentials.expiry_date) {
        await this.markReauthRequired(account, 'Google did not return a valid access token during refresh');
        return false;
      }

      await this.prisma.connectedAccount.update({
        where: { id: account.id },
        data: {
          accessToken: this.crypto.encrypt(credentials.access_token),
          ...(credentials.refresh_token ? { refreshToken: this.crypto.encrypt(credentials.refresh_token) } : {}),
          expiresAt: new Date(credentials.expiry_date),
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

      return true;
    } catch (error) {
      this.logger.warn(`Google token refresh failed for account ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
      await this.markReauthRequired(
        account,
        error instanceof Error ? error.message : 'Google token refresh failed',
      );
      return false;
    }
  }

  private async markReauthRequired(account: ConnectedAccount, reason: string): Promise<void> {
    await this.prisma.connectedAccount.update({
      where: { id: account.id },
      data: {
        status: 'REAUTH_REQUIRED',
        reauthRequiredAt: new Date(),
        lastSyncError: reason,
      },
    });
    await this.audit.log({
      userId: account.userId,
      accountId: account.id,
      action: AuditAction.GOOGLE_ACCOUNT_REAUTH_REQUIRED,
    });
  }

  private isTokenError(error: unknown): boolean {
    return error instanceof UnauthorizedException || error instanceof ForbiddenException;
  }
}
