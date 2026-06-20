import { BadGatewayException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import DodoPayments from 'dodopayments';

type CheckoutParams = {
  productId: string;
  customerEmail: string;
  customerName?: string | null;
  customerId?: string;
  metadata: Record<string, string>;
  redirectUrl: string;
  cancelUrl: string;
};

@Injectable()
export class DodoClient {
  private client?: DodoPayments;

  constructor(private readonly config: ConfigService) {}

  private getClient(): DodoPayments {
    const apiKey = this.config.get<string>('DODO_API_KEY') || this.config.get<string>('DODO_PAYMENTS_API_KEY');
    if (!apiKey) {
      throw new InternalServerErrorException('Dodo API key is not configured');
    }
    this.client ??= new DodoPayments({
      bearerToken: apiKey,
      environment: this.config.get<'test_mode' | 'live_mode'>('DODO_ENVIRONMENT') || 'live_mode',
    });
    return this.client;
  }

  async createSubscriptionCheckout(params: CheckoutParams): Promise<{ id: string; url: string }> {
    try {
      const session = await this.getClient().checkoutSessions.create({
        product_cart: [{ product_id: params.productId, quantity: 1 }],
        customer: params.customerId
          ? { customer_id: params.customerId }
          : { email: params.customerEmail, name: params.customerName ?? undefined },
        metadata: params.metadata,
        return_url: params.redirectUrl,
        cancel_url: params.cancelUrl,
      });
      const url = session.checkout_url;
      if (!url) throw new BadGatewayException('Dodo did not return a checkout URL');
      return { id: session.session_id, url };
    } catch (error) {
      if (error instanceof DodoPayments.APIError) {
        throw new BadGatewayException(`Dodo API error: ${error.status} ${error.message}`);
      }
      throw error;
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    try {
      await this.getClient().subscriptions.update(subscriptionId, { status: 'cancelled' } as never);
    } catch (error) {
      if (error instanceof DodoPayments.APIError) {
        throw new BadGatewayException(`Dodo API error: ${error.status} ${error.message}`);
      }
      throw error;
    }
  }

  async getCustomerPortal(customerId: string): Promise<{ url: string }> {
    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'http://localhost:3000';
    const portal = await this.getClient().customers.customerPortal.create(customerId, {
      return_url: `${frontendUrl}/settings/billing`,
      send_email: false,
    });
    return { url: portal.link };
  }
}
