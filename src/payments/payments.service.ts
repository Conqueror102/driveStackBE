import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuditService } from '../common/admin-audit/admin-audit.service';
import { BillingCurrency, GeoService } from '../common/geo/geo.service';
import { PrismaService } from '../prisma/prisma.service';
import { DodoClient } from './dodo.client';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dodo: DodoClient,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
    private readonly geo: GeoService,
  ) {}

  async createCheckoutSession(userId: string, ip: string): Promise<{ checkoutUrl: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { subscription: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.subscription?.plan === 'PRO' && user.subscription.status === 'ACTIVE') {
      throw new ConflictException('Already subscribed to Pro');
    }

    const currency = this.geo.getCurrency(user.country ?? 'UNKNOWN');
    const productId = await this.getProductId(currency);
    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const session = await this.dodo.createSubscriptionCheckout({
      productId,
      customerEmail: user.email,
      customerName: user.displayName,
      customerId: user.subscription?.dodoCustomerId ?? undefined,
      currency,
      country: user.country ?? 'UNKNOWN',
      metadata: { userId, currency },
      redirectUrl: `${frontendUrl}/payment/success`,
      cancelUrl: `${frontendUrl}/pricing`,
    });

    await this.audit.log({
      userId,
      action: 'payment.checkout_created',
      entity: 'Subscription',
      entityId: userId,
      metadata: { currency, productId, checkoutSessionId: session.id },
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

  private async getProductId(currency: BillingCurrency): Promise<string> {
    const pricing = await this.prisma.pricingConfig.findFirst({
      where: { key: currency === 'NGN' ? 'pro_ngn' : 'pro_usd', isActive: true },
    });
    if (pricing?.productId) return pricing.productId;

    const envKey = currency === 'NGN' ? 'DODO_PRO_PRODUCT_ID_NGN' : 'DODO_PRO_PRODUCT_ID_USD';
    const productId = this.config.get<string>(envKey);
    if (!productId) throw new InternalServerErrorException(`No product ID configured for currency: ${currency}`);
    return productId;
  }
}
