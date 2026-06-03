import { Logger } from '@nestjs/common';
import { EmailMessage, EmailProvider } from '../email.types';

export class ConsoleEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ConsoleEmailProvider.name);

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(`Email to ${message.to}: ${message.subject}`);
    this.logger.debug(message.text);
  }
}
