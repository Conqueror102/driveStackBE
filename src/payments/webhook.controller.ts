import { Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Webhook } from 'standardwebhooks';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookService } from './webhook.service';

@Controller('payments')
export class WebhookController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly webhooks: WebhookService,
  ) {}

  @Post('webhook')
  async handleWebhook(
    @Headers('webhook-id') webhookId: string,
    @Headers('webhook-signature') signature: string,
    @Headers('webhook-timestamp') timestamp: string,
    @Req() req: Request,
  ) {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    const secret = this.config.get<string>('DODO_WEBHOOK_SECRET') || this.config.get<string>('DODO_PAYMENTS_WEBHOOK_KEY');
    if (!secret) throw new UnauthorizedException('Webhook secret is not configured');

    try {
      new Webhook(secret).verify(rawBody, {
        'webhook-id': webhookId,
        'webhook-signature': signature,
        'webhook-timestamp': timestamp,
      });
    } catch {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const already = await this.prisma.processedWebhook.findUnique({ where: { webhookId } });
    if (already) return { status: 'already_processed' };

    await this.webhooks.process(webhookId, JSON.parse(rawBody.toString('utf8')));
    return { status: 'ok' };
  }
}
