import { Controller, Delete, Get, Logger, Param, Patch, Query, Redirect, Res, UseGuards } from '@nestjs/common';
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

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3001';
    try {
      const userId = await this.accountsService.consumeOAuthState(state);
      await this.accountsService.connectAccount(userId, code);
      return res.redirect(`${frontendUrl}/accounts?connected=true`);
    } catch (error) {
      this.logger.warn(`Google OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`);
      return res.redirect(`${frontendUrl}/accounts?error=oauth_failed`);
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
