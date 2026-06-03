import { EmailMessage, EmailProvider } from '../email.types';

export class CustomHttpEmailProvider implements EmailProvider {
  constructor(
    private readonly url: string,
    private readonly authHeader?: string,
    private readonly providerName = 'custom_http',
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }

    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: this.providerName,
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      throw new Error(`Custom HTTP email failed with status ${response.status}: ${await response.text()}`);
    }
  }
}
