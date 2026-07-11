import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuditAction, ConnectedAccount } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { NotificationType } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { DriveService } from '../drive/drive.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';
import { GoogleAuthService } from './google-auth.service';

export type SafeAccount = Pick<
  ConnectedAccount,
  | 'id'
  | 'googleEmail'
  | 'displayName'
  | 'avatarUrl'
  | 'storageLimit'
  | 'storageUsed'
  | 'isDefault'
  | 'quotaUpdatedAt'
  | 'status'
  | 'lastSyncAt'
  | 'lastSyncError'
  | 'reauthRequiredAt'
  | 'createdAt'
>;

@Injectable()
export class GoogleAccountsService {
  private readonly logger = new Logger(GoogleAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleAuth: GoogleAuthService,
    private readonly crypto: CryptoService,
    private readonly driveService: DriveService,
    private readonly audit: AuditService,
    private readonly featureGuard: FeatureGuardService,
    private readonly notifications: NotificationsService,
  ) {}

  async createConnectUrl(userId: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    await this.prisma.oAuthState.create({
      data: {
        userId,
        stateHash: this.hashState(state),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    return this.googleAuth.getAuthUrl(state);
  }

  async createReconnectUrl(userId: string, accountId: string): Promise<string> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }
    const state = randomBytes(32).toString('base64url');
    await this.prisma.oAuthState.create({
      data: {
        userId,
        stateHash: this.hashState(state),
        reconnectAccountId: account.id,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    // Pre-fill the Google account chooser with the exact email that needs reconnection
    // so the user can heal the right account instead of picking the wrong one.
    return this.googleAuth.getAuthUrl(state, account.googleEmail);
  }

  async consumeOAuthState(state: string): Promise<{ userId: string; reconnectAccountId: string | null }> {
    const stateHash = this.hashState(state);
    const oauthState = await this.prisma.oAuthState.findUnique({ where: { stateHash } });
    if (!oauthState || oauthState.usedAt || oauthState.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    await this.prisma.oAuthState.update({
      where: { id: oauthState.id },
      data: { usedAt: new Date() },
    });
    return { userId: oauthState.userId, reconnectAccountId: oauthState.reconnectAccountId };
  }

  async connectAccount(
    userId: string,
    code: string,
    reconnectAccountId?: string | null,
  ): Promise<ConnectedAccount> {
    const limit = await this.featureGuard.getAccountLimit(userId);
    const current = await this.prisma.connectedAccount.count({ where: { userId } });
    // A reconnect heals an existing account, so it never counts against the limit.
    if (!reconnectAccountId && current >= limit) {
      throw new ForbiddenException({
        code: 'FEATURE_LOCKED',
        feature: 'connect_account_above_limit',
        message: 'Upgrade to Pro to connect more than 2 accounts',
        upgradeUrl: '/pricing',
      });
    }

    const credentials = await this.googleAuth.exchangeCode(code);
    if (!credentials.access_token || !credentials.expiry_date) {
      throw new ForbiddenException('Google did not return usable credentials');
    }

    const userInfo = await this.googleAuth.getUserInfo(credentials.access_token);

    // Reconnect flow: the returned Google account MUST match the one being healed,
    // otherwise the user picked the wrong account in the chooser.
    if (reconnectAccountId) {
      const target = await this.prisma.connectedAccount.findUnique({ where: { id: reconnectAccountId } });
      if (!target || target.userId !== userId) {
        throw new ForbiddenException('Account does not belong to user');
      }
      if (userInfo.email !== target.googleEmail) {
        throw new BadRequestException(
          `Wrong Google account selected. Please choose ${target.googleEmail} to reconnect.`,
        );
      }
    }

    const existing = await this.prisma.connectedAccount.findUnique({
      where: { googleEmail: userInfo.email },
    });
    if (existing && existing.userId !== userId) {
      this.logger.warn(`Google account ${userInfo.email} is already connected to another app user`);
      throw new ConflictException('This Google account is already connected to another user');
    }

    const refreshToken = credentials.refresh_token
      ? this.crypto.encrypt(credentials.refresh_token)
      : existing?.refreshToken;

    if (!refreshToken) {
      throw new ForbiddenException('Google did not return a refresh token');
    }

    const account = await this.prisma.connectedAccount.upsert({
      where: { googleEmail: userInfo.email },
      update: {
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        accessToken: this.crypto.encrypt(credentials.access_token),
        refreshToken,
        expiresAt: new Date(credentials.expiry_date),
        status: 'ACTIVE',
        reauthRequiredAt: null,
        lastSyncError: null,
      },
      create: {
        userId,
        googleEmail: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        accessToken: this.crypto.encrypt(credentials.access_token),
        refreshToken,
        expiresAt: new Date(credentials.expiry_date),
        status: 'ACTIVE',
      },
    });

    await this.audit.log({
      userId,
      accountId: account.id,
      action: existing ? AuditAction.GOOGLE_ACCOUNT_REAUTHED : AuditAction.GOOGLE_ACCOUNT_CONNECTED,
      metadata: { googleEmail: account.googleEmail },
    });
    this.logger.log(`Google account ${account.googleEmail} connected for user ${userId}`);

    return account;
  }

  async listAccounts(userId: string): Promise<SafeAccount[]> {
    return this.prisma.connectedAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        googleEmail: true,
        displayName: true,
        avatarUrl: true,
        storageLimit: true,
        storageUsed: true,
        isDefault: true,
        quotaUpdatedAt: true,
        status: true,
        lastSyncAt: true,
        lastSyncError: true,
        reauthRequiredAt: true,
        createdAt: true,
      },
    });
  }

  async disconnectAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }
    try {
      await this.googleAuth.revokeToken(this.crypto.decrypt(account.refreshToken));
    } catch (error) {
      this.logger.warn(`Google token revoke failed for account ${account.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.audit.log({
      userId,
      accountId,
      action: AuditAction.GOOGLE_ACCOUNT_DISCONNECTED,
      metadata: { googleEmail: account.googleEmail },
    });
    await this.prisma.connectedAccount.delete({ where: { id: accountId } });
  }

  async setDefaultAccount(userId: string, accountId: string): Promise<SafeAccount> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    await this.prisma.$transaction([
      this.prisma.connectedAccount.updateMany({
        where: { userId },
        data: { isDefault: false },
      }),
      this.prisma.connectedAccount.update({
        where: { id: accountId },
        data: { isDefault: true },
      }),
    ]);

    return this.getSafeAccount(userId, accountId);
  }

  async removeDefaultAccount(userId: string, accountId: string): Promise<SafeAccount> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account || account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    await this.prisma.connectedAccount.update({
      where: { id: accountId },
      data: { isDefault: false },
    });

    return this.getSafeAccount(userId, accountId);
  }

  async refreshQuota(userId: string, accountId: string): Promise<SafeAccount> {
    const account = await this.prisma.connectedAccount.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException('Account not found');
    }
    if (account.userId !== userId) {
      throw new ForbiddenException('Account does not belong to user');
    }

    const quota = await this.getQuotaWithRefresh(account);
    return this.prisma.connectedAccount.update({
      where: { id: accountId },
      data: {
        storageLimit: quota.limit,
        storageUsed: quota.usage,
        quotaUpdatedAt: new Date(),
        status: 'ACTIVE',
        lastSyncError: null,
      },
      select: {
        id: true,
        googleEmail: true,
        displayName: true,
        avatarUrl: true,
        storageLimit: true,
        storageUsed: true,
        isDefault: true,
        quotaUpdatedAt: true,
        status: true,
        lastSyncAt: true,
        lastSyncError: true,
        reauthRequiredAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Proactively refresh access tokens for accounts whose tokens expire soon.
   * Runs from a scheduled job (not the request path) so normal API traffic
   * isn't slowed by N Google refresh calls. On failure, the account is marked
   * REAUTH_REQUIRED by refreshAccountTokens.
   */
  async refreshExpiringAccounts(withinMs = 60 * 60 * 1000): Promise<void> {
    const threshold = new Date(Date.now() + withinMs);
    const accounts = await this.prisma.connectedAccount.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: threshold } },
    });
    for (const account of accounts) {
      await this.refreshAccountTokens(account);
    }
  }

  private async getQuotaWithRefresh(account: ConnectedAccount) {
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
        throw new ForbiddenException(
          `Google account ${account.googleEmail} requires re-authentication. Token refresh failed.`,
        );
      }

      // Refresh succeeded — retry the Drive call with the new token
      const updatedAccount = await this.prisma.connectedAccount.findUnique({ where: { id: account.id } });
      if (!updatedAccount) {
        throw new NotFoundException('Account not found');
      }

      try {
        return await this.driveService.getQuota(this.crypto.decrypt(updatedAccount.accessToken));
      } catch (retryError) {
        // Refresh succeeded but Drive still rejects us — scope was likely revoked
        this.logger.warn(
          `Drive API still forbidden after token refresh for account ${account.id} (${account.googleEmail}). Marking as REAUTH_REQUIRED.`,
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

  private async refreshAccountTokens(account: ConnectedAccount): Promise<boolean> {
    try {
      const creds = await this.googleAuth.refreshAccessToken(this.crypto.decrypt(account.refreshToken));
      if (!creds.access_token || !creds.expiry_date) {
        await this.markReauthRequired(account, 'Google did not return a valid access token during refresh');
        return false;
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
    // Only notify on the ACTIVE -> REAUTH_REQUIRED transition so a persistently
    // broken account doesn't spam the user on every refresh attempt.
    if (account.status !== 'REAUTH_REQUIRED') {
      await this.notifications.create(
        account.userId,
        NotificationType.REAUTH_REQUIRED,
        `${account.googleEmail} needs to be reconnected to keep syncing.`,
      );
    }
  }

  private isTokenError(error: unknown): boolean {
    return error instanceof UnauthorizedException || error instanceof ForbiddenException;
  }

  private hashState(state: string): string {
    return createHash('sha256').update(state).digest('hex');
  }

  private async getSafeAccount(userId: string, accountId: string): Promise<SafeAccount> {
    const account = await this.prisma.connectedAccount.findFirst({
      where: { id: accountId, userId },
      select: {
        id: true,
        googleEmail: true,
        displayName: true,
        avatarUrl: true,
        storageLimit: true,
        storageUsed: true,
        isDefault: true,
        quotaUpdatedAt: true,
        status: true,
        lastSyncAt: true,
        lastSyncError: true,
        reauthRequiredAt: true,
        createdAt: true,
      },
    });
    if (!account) {
      throw new NotFoundException('Account not found');
    }
    return account;
  }
}
