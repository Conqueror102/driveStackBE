import { EmailMessage, EmailProvider } from '../email.types';

export class ResendEmailProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });

    if (!response.ok) {
      throw new Error(`Resend email failed with status ${response.status}: ${await response.text()}`);
    }
  }
}
