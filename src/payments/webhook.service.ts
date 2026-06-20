import { Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(webhookId: string, event: Record<string, any>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.processedWebhook.create({
        data: { webhookId, eventType: this.eventType(event) },
      });

      switch (this.eventType(event)) {
        case 'subscription.active':
        case 'subscription.renewed':
          await this.upsertProSubscription(tx, event, 'ACTIVE');
          await this.convertReferralIfExists(tx, this.metadata(event).userId);
          break;
        case 'subscription.on_hold':
          await this.upsertProSubscription(tx, event, 'ON_HOLD');
          break;
        case 'subscription.cancelled':
          await this.markSubscription(tx, event, 'CANCELLED');
          break;
        case 'subscription.expired':
          await this.markSubscription(tx, event, 'EXPIRED', true);
          break;
        case 'payment.succeeded':
          await this.recordPayment(tx, event, 'SUCCEEDED');
          await this.convertReferralIfExists(tx, this.metadata(event).userId);
          break;
        case 'payment.failed':
          await this.recordPayment(tx, event, 'FAILED');
          break;
        case 'refund.succeeded':
          await this.recordPayment(tx, event, 'REFUNDED', 'REFUND');
          await this.markSubscription(tx, event, 'EXPIRED', true);
          await this.revokeReferralReward(tx, this.metadata(event).userId);
          break;
        case 'dispute.opened':
          await this.recordPayment(tx, event, 'DISPUTED');
          await this.auditInTransaction(tx, event, 'dispute.opened');
          break;
        case 'dispute.won':
          await this.auditInTransaction(tx, event, 'dispute.won');
          break;
        case 'dispute.lost':
          await this.markSubscription(tx, event, 'EXPIRED', true);
          await this.auditInTransaction(tx, event, 'dispute.lost');
          break;
        default:
          this.logger.warn(`Unhandled webhook event: ${this.eventType(event)}`);
      }
    });
  }

  private async upsertProSubscription(tx: Tx, event: Record<string, any>, status: 'ACTIVE' | 'ON_HOLD') {
    const metadata = this.metadata(event);
    if (!metadata.userId) return;
    const data = this.payload(event);
    await tx.subscription.upsert({
      where: { userId: metadata.userId },
      create: {
        userId: metadata.userId,
        dodoCustomerId: this.customerId(data),
        dodoSubscriptionId: this.subscriptionId(data),
        plan: 'PRO',
        status,
        currency: (data.currency ?? metadata.currency ?? 'USD').toUpperCase(),
        interval: this.toInterval(data),
        priceAmount: Number(data.recurring_pre_tax_amount ?? data.amount ?? data.total_amount ?? 0),
        currentPeriodStart: this.toDate(data.previous_billing_date ?? data.current_period_start),
        currentPeriodEnd: this.toDate(data.next_billing_date ?? data.current_period_end ?? data.expires_at),
        gracePeriodEndsAt: status === 'ON_HOLD' ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) : null,
      },
      update: {
        dodoCustomerId: this.customerId(data) ?? undefined,
        dodoSubscriptionId: this.subscriptionId(data) ?? undefined,
        plan: 'PRO',
        status,
        currency: (data.currency ?? metadata.currency ?? 'USD').toUpperCase(),
        interval: this.toInterval(data),
        priceAmount: Number(data.recurring_pre_tax_amount ?? data.amount ?? data.total_amount ?? 0),
        currentPeriodStart: this.toDate(data.previous_billing_date ?? data.current_period_start),
        currentPeriodEnd: this.toDate(data.next_billing_date ?? data.current_period_end ?? data.expires_at),
        gracePeriodEndsAt: status === 'ON_HOLD' ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) : null,
      },
    });
    await this.auditInTransaction(tx, event, `subscription.${status.toLowerCase()}`);
  }

  private async markSubscription(tx: Tx, event: Record<string, any>, status: 'CANCELLED' | 'EXPIRED', downgrade = false) {
    const userId = this.metadata(event).userId;
    if (!userId) return;
    await tx.subscription.updateMany({
      where: { userId },
      data: {
        status,
        ...(downgrade ? { plan: 'FREE' as const } : {}),
        ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
      },
    });
    await this.auditInTransaction(tx, event, `subscription.${status.toLowerCase()}`);
  }

  private async recordPayment(
    tx: Tx,
    event: Record<string, any>,
    status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'DISPUTED',
    type: 'SUBSCRIPTION_PAYMENT' | 'REFUND' = 'SUBSCRIPTION_PAYMENT',
  ) {
    const userId = this.metadata(event).userId;
    if (!userId) return;
    const data = this.payload(event);
    const dodoPaymentId = data.payment_id ?? data.paymentId ?? data.id ?? `${this.eventType(event)}:${event.timestamp ?? Date.now()}`;
    await tx.payment.upsert({
      where: { dodoPaymentId },
      create: {
        userId,
        dodoPaymentId,
        subscriptionId: this.subscriptionId(data),
        amount: Number(data.amount ?? data.total_amount ?? 0),
        currency: (data.currency ?? this.metadata(event).currency ?? 'USD').toUpperCase(),
        status,
        type,
        description: data.description ?? null,
        metadata: data as Prisma.InputJsonValue,
      },
      update: {
        status,
        metadata: data as Prisma.InputJsonValue,
      },
    });
  }

  private async convertReferralIfExists(tx: Tx, userId?: string): Promise<void> {
    if (!userId) return;
    const referral = await tx.referral.findUnique({ where: { referredUserId: userId } });
    if (!referral || referral.status !== 'PENDING') return;

    const referrer = await tx.user.findUnique({ where: { id: referral.referrerId } });
    if (!referrer) return;
    const grantReward = referrer.bonusSlots < 3;

    await tx.referral.update({
      where: { id: referral.id },
      data: {
        status: 'CONVERTED',
        convertedAt: new Date(),
        rewardGranted: grantReward,
      },
    });

    if (grantReward) {
      await tx.user.update({
        where: { id: referral.referrerId },
        data: { bonusSlots: { increment: 1 } },
      });
    }
  }

  private async revokeReferralReward(tx: Tx, userId?: string): Promise<void> {
    if (!userId) return;
    const referral = await tx.referral.findUnique({ where: { referredUserId: userId } });
    if (!referral || !referral.rewardGranted || referral.rewardRevoked) return;
    await tx.referral.update({
      where: { id: referral.id },
      data: { status: 'REVOKED', rewardRevoked: true },
    });
    await tx.user.updateMany({
      where: { id: referral.referrerId, bonusSlots: { gt: 0 } },
      data: { bonusSlots: { decrement: 1 } },
    });
  }

  private async auditInTransaction(tx: Tx, event: Record<string, any>, action: string): Promise<void> {
    const userId = this.metadata(event).userId;
    await tx.adminAuditLog.create({
      data: {
        userId,
        action,
        entity: 'DodoWebhook',
        entityId: event.id ?? event.event_id ?? action,
        metadata: event as Prisma.InputJsonValue,
      },
    });
  }

  private metadata(event: Record<string, any>): Record<string, string | undefined> {
    return (this.payload(event).metadata ?? event.metadata ?? {}) as Record<string, string | undefined>;
  }

  private eventType(event: Record<string, any>): string {
    return String(event.type ?? event.event_type ?? 'unknown');
  }

  private payload(event: Record<string, any>): Record<string, any> {
    return (event.data ?? event.payload ?? event) as Record<string, any>;
  }

  private customerId(data: Record<string, any>): string | null {
    return data.customer_id ?? data.customerId ?? data.customer?.customer_id ?? data.customer?.id ?? null;
  }

  private subscriptionId(data: Record<string, any>): string | null {
    return data.subscription_id ?? data.subscriptionId ?? (data.payload_type === 'Subscription' ? data.id : null) ?? null;
  }

  private toInterval(data: Record<string, any>): string {
    return String(data.payment_frequency_interval ?? data.subscription_period_interval ?? 'month').toLowerCase();
  }

  private toDate(value: unknown): Date | undefined {
    if (!value) return undefined;
    if (typeof value === 'number') return new Date(value * 1000);
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
}
