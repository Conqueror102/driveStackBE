import { BadRequestException, Controller, Delete, Get, Logger, Param, Patch, Query, Redirect, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SafeUser } from '../auth/auth.service';
import { GoogleAccountsService } from './google-accounts.service';
import { GoogleAuthService } from './google-auth.service';

@Controller('google-accounts')
export class GoogleAccountsController {
  private readonly logger = new Logger(GoogleAccountsController.name);

  constructor(
    private readonly accountsService: GoogleAccountsService,
    private readonly googleAuth: GoogleAuthService,
    private readonly configService: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  list(@CurrentUser() user: SafeUser) {
    return this.accountsService.listAccounts(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('connect')
  @Redirect()
  async connect(@CurrentUser() user: SafeUser) {
    return { url: await this.accountsService.createConnectUrl(user.id) };
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/reconnect')
  @Redirect()
  async reconnect(@CurrentUser() user: SafeUser, @Param('id') accountId: string) {
    return { url: await this.accountsService.createReconnectUrl(user.id, accountId) };
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3001';
    try {
      const { userId, reconnectAccountId } = await this.accountsService.consumeOAuthState(state);
      await this.accountsService.connectAccount(userId, code, reconnectAccountId);
      const flag = reconnectAccountId ? 'reconnected=true' : 'connected=true';
      return res.redirect(`${frontendUrl}/accounts?${flag}`);
    } catch (error) {
      this.logger.warn(`Google OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`);
      // Surface the wrong-account case distinctly so the UI can prompt a corrective retry.
      const isWrongAccount = error instanceof BadRequestException;
      const errorCode = isWrongAccount ? 'wrong_account' : 'oauth_failed';
      return res.redirect(`${frontendUrl}/accounts?error=${errorCode}`);
    }
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async disconnect(@CurrentUser() user: SafeUser, @Param('id') accountId: string) {
    await this.accountsService.disconnectAccount(user.id, accountId);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/set-default')
  setDefault(@CurrentUser() user: SafeUser, @Param('id') accountId: string) {
    return this.accountsService.setDefaultAccount(user.id, accountId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id/remove-default')
  removeDefault(@CurrentUser() user: SafeUser, @Param('id') accountId: string) {
    return this.accountsService.removeDefaultAccount(user.id, accountId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/quota')
  quota(@CurrentUser() user: SafeUser, @Param('id') accountId: string) {
    return this.accountsService.refreshQuota(user.id, accountId);
  }
}
