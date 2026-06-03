import { EmailMessage, EmailProvider } from '../email.types';

export class SendGridEmailProvider implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: message.from },
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`SendGrid email failed with status ${response.status}: ${await response.text()}`);
    }
  }
}
