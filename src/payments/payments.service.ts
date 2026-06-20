import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuditService } from '../common/admin-audit/admin-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { DodoClient } from './dodo.client';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dodo: DodoClient,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
  ) {}

  async getPricing(): Promise<{
    plans: {
      key: string;
      amount: number;
      currency: string;
      interval: string;
      isActive: boolean;
    }[];
  }> {
    const configs = await this.prisma.pricingConfig.findMany({
      where: { isActive: true },
      select: { key: true, amount: true, currency: true, interval: true, isActive: true },
    });

    // If admin hasn't configured pricing yet, return sensible defaults
    if (configs.length === 0) {
      return {
        plans: [
          { key: 'pro_ngn', amount: 1500, currency: 'NGN', interval: 'month', isActive: true },
          { key: 'pro_usd', amount: 2, currency: 'USD', interval: 'month', isActive: true },
        ],
      };
    }

    return { plans: configs };
  }

  async createCheckoutSession(userId: string, ip: string): Promise<{ checkoutUrl: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.subscription?.plan === 'PRO' && user.subscription.status === 'ACTIVE') {
      throw new ConflictException('Already subscribed to Pro');
    }

    const productId = await this.getProductId();
    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const session = await this.dodo.createSubscriptionCheckout({
      productId,
      customerEmail: user.email,
      customerName: user.displayName,
      customerId: user.subscription?.dodoCustomerId ?? undefined,
      metadata: { userId },
      redirectUrl: `${frontendUrl}/payment/success`,
      cancelUrl: `${frontendUrl}/pricing`,
    });

    await this.audit.log({
      userId,
      action: 'payment.checkout_created',
      entity: 'Subscription',
      entityId: userId,
      metadata: { productId, checkoutSessionId: session.id },
      ipAddress: ip,
    });

    return { checkoutUrl: session.url };
  }

  async cancelSubscription(userId: string): Promise<{ success: true }> {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub?.dodoSubscriptionId) throw new NotFoundException('Subscription not found');
    if (sub.plan === 'FREE') throw new BadRequestException('No active subscription');

    await this.dodo.cancelSubscription(sub.dodoSubscriptionId);
    await this.prisma.subscription.update({
      where: { userId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    await this.audit.log({
      userId,
      action: 'subscription.cancelled',
      entity: 'Subscription',
      entityId: sub.id,
      before: { status: sub.status },
      after: { status: 'CANCELLED' },
    });
    return { success: true };
  }

  async getCustomerPortalUrl(userId: string): Promise<{ url: string }> {
    const sub = await this.prisma.subscription.findUnique({ where: { userId } });
    if (!sub?.dodoCustomerId) throw new NotFoundException('Customer not found');
    return this.dodo.getCustomerPortal(sub.dodoCustomerId);
  }

  private async getProductId(): Promise<string> {
    // Check if admin has configured a product ID in the database
    const pricing = await this.prisma.pricingConfig.findFirst({
      where: { isActive: true },
    });
    if (pricing?.productId) return pricing.productId;

    // Fall back to env var — single USD product, Dodo handles currency via Adaptive Currency
    const productId = this.config.get<string>('DODO_PRO_PRODUCT_ID');
    if (!productId) throw new InternalServerErrorException('No Dodo product ID configured');
    return productId;
  }
}
