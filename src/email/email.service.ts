import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConsoleEmailProvider } from './providers/console.provider';
import { CustomHttpEmailProvider } from './providers/custom-http.provider';
import { ResendEmailProvider } from './providers/resend.provider';
import { SendGridEmailProvider } from './providers/sendgrid.provider';
import { ZohoEmailProvider } from './providers/zoho.provider';
import { EmailMessage, EmailProvider } from './email.types';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {}

  async send(message: Omit<EmailMessage, 'from'>): Promise<void> {
    const provider = this.createProvider();
    const email = { ...message, from: this.from() };
    await provider.send(email);
    this.logger.log(`Email sent via ${this.providerName()} to ${message.to}: ${message.subject}`);
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    const url = this.buildUrl('/verify-email', token);
    await this.send({
      to,
      subject: 'Verify your email',
      text: `Verify your email using this link: ${url}`,
      html: `<p>Verify your email using this link:</p><p><a href="${url}">${url}</a></p>`,
    });
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    const url = this.buildUrl('/reset-password', token);
    await this.send({
      to,
      subject: 'Reset your password',
      text: `Reset your password using this link: ${url}`,
      html: `<p>Reset your password using this link:</p><p><a href="${url}">${url}</a></p>`,
    });
  }

  private createProvider(): EmailProvider {
    const provider = this.providerName();
    if (provider === 'sendgrid') {
      return new SendGridEmailProvider(this.config.getOrThrow<string>('SENDGRID_API_KEY'));
    }
    if (provider === 'resend') {
      return new ResendEmailProvider(this.config.getOrThrow<string>('RESEND_API_KEY'));
    }
    if (provider === 'zoho') {
      return new ZohoEmailProvider(
        this.config.getOrThrow<string>('ZOHO_API_KEY'),
        this.config.get<string>('ZOHO_API_URL') || 'https://api.zeptomail.com/v1.1/email',
      );
    }
    if (provider === 'custom_http') {
      return new CustomHttpEmailProvider(
        this.config.getOrThrow<string>('EMAIL_HTTP_URL'),
        this.config.get<string>('EMAIL_HTTP_AUTH_HEADER'),
        this.config.get<string>('EMAIL_HTTP_PROVIDER_NAME') || 'custom_http',
      );
    }
    return new ConsoleEmailProvider();
  }

  private providerName(): string {
    return (this.config.get<string>('EMAIL_PROVIDER') || 'console').toLowerCase();
  }

  private buildUrl(path: string, token: string): string {
    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'http://localhost:3001';
    return `${frontendUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  private from(): string {
    return this.config.get<string>('EMAIL_FROM') || 'no-reply@example.com';
  }
}
