import { EmailMessage, EmailProvider } from '../email.types';

export class ZohoEmailProvider implements EmailProvider {
  constructor(
    private readonly apiKey: string,
    private readonly apiUrl: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-enczapikey ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { address: message.from },
        to: [{ email_address: { address: message.to } }],
        subject: message.subject,
        htmlbody: message.html,
        textbody: message.text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Zoho email failed with status ${response.status}: ${await response.text()}`);
    }
  }
}
