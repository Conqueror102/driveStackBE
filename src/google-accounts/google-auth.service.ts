import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';

export type GoogleCredentials = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
};

@Injectable()
export class GoogleAuthService {
  constructor(private readonly configService: ConfigService) {}

  getAuthUrl(state: string): string {
    const client = this.createOAuthClient();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      state,
      scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
    });
  }

  async exchangeCode(code: string): Promise<GoogleCredentials> {
    const client = this.createOAuthClient();
    const { tokens } = await client.getToken(code);
    return tokens;
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleCredentials> {
    const client = this.createOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    return credentials;
  }

  async getUserInfo(accessToken: string): Promise<{ email: string; name: string; picture: string }> {
    const client = this.createOAuthClient();
    client.setCredentials({ access_token: accessToken });
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    return {
      email: data.email || '',
      name: data.name || '',
      picture: data.picture || '',
    };
  }

  async revokeToken(token: string): Promise<void> {
    const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!response.ok && response.status !== 400) {
      throw new Error(`Google token revoke failed with status ${response.status}`);
    }
  }

  private createOAuthClient() {
    return new google.auth.OAuth2(
      this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      this.configService.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      this.configService.getOrThrow<string>('GOOGLE_REDIRECT_URI'),
    );
  }
}
