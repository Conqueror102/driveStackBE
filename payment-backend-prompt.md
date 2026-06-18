# Backend Payment Integration Prompt — DriveStack
# Dodo Payments · Subscriptions · Referrals · Feature Locking
# Security · Admin Audit · Price Management

---

## IMPORTANT — READ FIRST

Before writing any payment code, fetch and read the latest
Dodo Payments documentation from:

```
https://docs.dodopayments.com
https://docs.dodopayments.com/api-reference/introduction
https://docs.dodopayments.com/developer-resources/subscription-integration-guide
https://docs.dodopayments.com/features/webhooks
```

Dodo Payments updates their API regularly. The implementation
must match their current 2025/2026 API — not older versions.
Use the official `dodopayments` npm SDK if available.
If not, use their REST API with typed fetch wrappers.

Install:
```bash
npm install dodopayments standardwebhooks
```

---

## Subscription model

```
Free — forever
  └── 2 Google accounts maximum
  └── Basic file browser (read only)
  └── Manual uploads only
  └── Smart recommendation (view only)

Pro — ₦800/month (NGN) or $1.99/month (USD)
  └── Unlimited Google accounts
  └── All features active and automated
  └── Move files between accounts
  └── Duplicate detector (weekly automated scan)
  └── Bulk operations
  └── Storage alerts + notifications
  └── Storage history chart
  └── Upload from URL
  └── File preview
  └── Connect new accounts above 2
```

### On subscription expiry — the rule

Never delete what the user already has.
Only lock what they want to do next.

```
Expires:
  ✓ All existing connected accounts remain visible
  ✓ Existing files remain visible in browser
  ✓ Basic file viewing works on all accounts
  ✗ Cannot connect NEW accounts above 2
  ✗ Move files between accounts — locked
  ✗ Duplicate detector — locked
  ✗ Bulk operations — locked
  ✗ Storage alerts — locked
  ✗ Storage history — locked
  ✗ Upload from URL — locked
  ✗ File preview — locked
```

---

## New packages to install

```bash
npm install dodopayments standardwebhooks
npm install @nestjs/event-emitter  # for internal events
```

---

## New environment variables

```env
# Dodo Payments
DODO_API_KEY=your_dodo_api_key
DODO_WEBHOOK_SECRET=your_dodo_webhook_secret
DODO_PRO_PRODUCT_ID_NGN=your_ngn_product_id
DODO_PRO_PRODUCT_ID_USD=your_usd_product_id

# App
FRONTEND_URL=http://localhost:3000
ADMIN_SECRET=a_long_random_string_for_admin_endpoints
```

---

## New folder structure

```
src/
  payments/
    payments.module.ts
    payments.controller.ts
    payments.service.ts
    webhook.controller.ts
    webhook.service.ts
    dodo.client.ts          ← typed Dodo API wrapper
    dto/
      create-checkout.dto.ts
      webhook-event.dto.ts

  subscriptions/
    subscriptions.module.ts
    subscriptions.service.ts
    feature-guard.service.ts  ← checks if feature is available

  referrals/
    referrals.module.ts
    referrals.controller.ts
    referrals.service.ts
    dto/
      create-referral.dto.ts

  admin/
    admin.module.ts
    admin.controller.ts
    admin.service.ts
    guards/
      admin.guard.ts
    dto/
      update-pricing.dto.ts
      manual-upgrade.dto.ts
```

---

## Prisma schema additions

Add all of these to the existing schema in one migration:

```prisma
// ─── New fields on User ───────────────────────────────────

model User {
  // ... existing fields ...
  bonusSlots    Int     @default(0)
  signupIp      String?
  country       String? // "NG" or ISO country code
  referralCode  String? @unique

  subscription  Subscription?
  payments      Payment[]
  referralsMade Referral[]    @relation("referrer")
  referredBy    Referral?     @relation("referred")
  auditLogs     AdminAuditLog[]
}

// ─── Subscription ────────────────────────────────────────

model Subscription {
  id                  String             @id @default(cuid())
  userId              String             @unique
  dodoCustomerId      String?
  dodoSubscriptionId  String?            @unique
  plan                SubscriptionPlan   @default(FREE)
  status              SubscriptionStatus @default(ACTIVE)
  currency            String             @default("NGN")
  interval            String             @default("month")
  priceAmount         Int                @default(0)
  currentPeriodStart  DateTime?
  currentPeriodEnd    DateTime?
  cancelledAt         DateTime?
  gracePeriodEndsAt   DateTime?
  trialEndsAt         DateTime?
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([dodoSubscriptionId])
  @@index([status])
  @@index([currentPeriodEnd])
  @@index([gracePeriodEndsAt])
}

enum SubscriptionPlan {
  FREE
  PRO
}

enum SubscriptionStatus {
  ACTIVE
  ON_HOLD
  CANCELLED
  EXPIRED
  PAST_DUE
}

// ─── Payment audit ────────────────────────────────────────

model Payment {
  id             String        @id @default(cuid())
  userId         String
  dodoPaymentId  String        @unique
  subscriptionId String?
  amount         Int
  currency       String
  status         PaymentStatus
  type           PaymentType
  description    String?
  metadata       Json?
  createdAt      DateTime      @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([dodoPaymentId])
  @@index([createdAt])
}

enum PaymentStatus {
  SUCCEEDED
  FAILED
  REFUNDED
  DISPUTED
  CANCELLED
}

enum PaymentType {
  SUBSCRIPTION_PAYMENT
  REFUND
}

// ─── Idempotency ─────────────────────────────────────────

model ProcessedWebhook {
  id          String   @id @default(cuid())
  webhookId   String   @unique
  eventType   String
  processedAt DateTime @default(now())

  @@index([webhookId])
  @@index([processedAt])
}

// ─── Referrals ────────────────────────────────────────────

model Referral {
  id             String         @id @default(cuid())
  referrerId     String
  referredUserId String         @unique
  status         ReferralStatus @default(PENDING)
  rewardGranted  Boolean        @default(false)
  rewardRevoked  Boolean        @default(false)
  convertedAt    DateTime?
  createdAt      DateTime       @default(now())

  referrer     User @relation("referrer",
                    fields: [referrerId], references: [id])
  referredUser User @relation("referred",
                    fields: [referredUserId], references: [id])

  @@index([referrerId])
  @@index([status])
}

enum ReferralStatus {
  PENDING    // signed up, not paid yet
  CONVERTED  // paid — reward granted
  EXPIRED    // signed up but never paid in 30 days
  REVOKED    // payment was refunded
}

// ─── Admin audit log ──────────────────────────────────────

model AdminAuditLog {
  id        String   @id @default(cuid())
  userId    String?
  action    String
  entity    String
  entityId  String
  before    Json?    // state before change
  after     Json?    // state after change
  metadata  Json?
  ipAddress String?
  createdAt DateTime @default(now())

  user User? @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([action])
  @@index([entity])
  @@index([createdAt])
}

// ─── Pricing config ───────────────────────────────────────

model PricingConfig {
  id            String   @id @default(cuid())
  key           String   @unique  // e.g. "pro_ngn", "pro_usd"
  productId     String            // Dodo product ID
  amount        Int               // in smallest unit
  currency      String
  interval      String            // "month" or "year"
  isActive      Boolean  @default(true)
  updatedAt     DateTime @updatedAt
  updatedBy     String?           // admin userId
  createdAt     DateTime @default(now())

  @@index([key])
  @@index([isActive])
}
```

Run:
```bash
npx prisma migrate dev --name add_payments_referrals_audit
npx prisma generate
```

---

## PaymentsModule

### `dodo.client.ts` — typed Dodo API wrapper

```typescript
@Injectable()
export class DodoClient {
  private readonly baseUrl = 'https://api.dodopayments.com/v1'
  private readonly apiKey  = this.config.get<string>('DODO_API_KEY')

  constructor(private config: ConfigService) {}

  private async request<T>(
    method:  string,
    path:    string,
    body?:   object,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization:  `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const err = await res.text()
      throw new BadRequestException(`Dodo API error: ${res.status} ${err}`)
    }

    return res.json()
  }

  // Create a subscription checkout session
  async createSubscription(params: {
    productId:   string
    customerEmail: string
    customerId?:  string
    metadata?:   Record<string, string>
    redirectUrl: string
  }) {
    // READ THE DODO DOCS for the exact request shape
    // https://docs.dodopayments.com/api-reference/subscriptions/create
    return this.request('POST', '/subscriptions', params)
  }

  // Cancel a subscription
  async cancelSubscription(subscriptionId: string) {
    return this.request(
      'PATCH',
      `/subscriptions/${subscriptionId}`,
      { status: 'cancelled' }
    )
  }

  // Get subscription details
  async getSubscription(subscriptionId: string) {
    return this.request('GET', `/subscriptions/${subscriptionId}`)
  }

  // Get customer portal URL
  async getCustomerPortal(customerId: string) {
    return this.request('POST', `/customers/${customerId}/portal`)
  }
}
```

**IMPORTANT:** The exact request and response shapes must match
the current Dodo Payments API documentation. Read
`https://docs.dodopayments.com/api-reference/introduction`
before implementing each method. API shapes change — always
use the latest docs, not assumptions.

---

### `payments.service.ts`

```typescript
@Injectable()
export class PaymentsService {
  constructor(
    private prisma:        PrismaService,
    private dodo:          DodoClient,
    private config:        ConfigService,
    private auditService:  AdminAuditService,
  ) {}

  async createCheckoutSession(
    userId:   string,
    currency: string,  // 'NGN' or 'USD'
    ip:       string,
  ): Promise<{ checkoutUrl: string }> {

    const user = await this.prisma.user.findUnique({
      where:   { id: userId },
      include: { subscription: true },
    })
    if (!user) throw new NotFoundException()

    // Do not create a new session if already Pro
    if (user.subscription?.plan === 'PRO' &&
        user.subscription?.status === 'ACTIVE') {
      throw new ConflictException('Already subscribed to Pro')
    }

    // Get the correct product ID for this currency
    const productIdKey = currency === 'NGN'
      ? 'DODO_PRO_PRODUCT_ID_NGN'
      : 'DODO_PRO_PRODUCT_ID_USD'

    // Check PricingConfig table first — allows admin to update
    const pricingConfig = await this.prisma.pricingConfig.findUnique({
      where: { key: currency === 'NGN' ? 'pro_ngn' : 'pro_usd' }
    })

    const productId = pricingConfig?.productId
      ?? this.config.get<string>(productIdKey)

    if (!productId) throw new InternalServerErrorException('Pricing not configured')

    const session = await this.dodo.createSubscription({
      productId,
      customerEmail: user.email,
      customerId:    user.subscription?.dodoCustomerId ?? undefined,
      metadata: {
        userId,
        currency,
      },
      redirectUrl: `${this.config.get('FRONTEND_URL')}/payment/success`,
    })

    // Log the checkout attempt
    await this.auditService.log({
      userId,
      action:   'payment.checkout_created',
      entity:   'Subscription',
      entityId: userId,
      metadata: { currency, productId },
      ipAddress: ip,
    })

    return { checkoutUrl: session.url ?? session.checkoutUrl }
  }

  async cancelSubscription(userId: string): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId }
    })
    if (!sub?.dodoSubscriptionId) throw new NotFoundException()
    if (sub.plan === 'FREE') throw new BadRequestException('No active subscription')

    await this.dodo.cancelSubscription(sub.dodoSubscriptionId)

    await this.prisma.subscription.update({
      where: { userId },
      data:  { status: 'CANCELLED', cancelledAt: new Date() }
    })

    await this.auditService.log({
      userId,
      action:   'subscription.cancelled',
      entity:   'Subscription',
      entityId: sub.id,
      before:   { status: sub.status },
      after:    { status: 'CANCELLED' },
    })
  }

  async getCustomerPortalUrl(userId: string): Promise<{ url: string }> {
    const sub = await this.prisma.subscription.findUnique({
      where: { userId }
    })
    if (!sub?.dodoCustomerId) throw new NotFoundException()

    const portal = await this.dodo.getCustomerPortal(sub.dodoCustomerId)
    return { url: portal.url }
  }
}
```

---

### `payments.controller.ts`

```typescript
@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentsController {

  @Post('checkout')
  async createCheckout(
    @Body()        dto:  CreateCheckoutDto,
    @CurrentUser() user: User,
    @Req()         req:  Request,
  ) {
    const ip = req.ip ?? req.headers['x-forwarded-for'] as string
    return this.paymentsService.createCheckoutSession(
      user.id, dto.currency, ip
    )
  }

  @Post('cancel')
  async cancel(@CurrentUser() user: User) {
    return this.paymentsService.cancelSubscription(user.id)
  }

  @Get('portal')
  async portal(@CurrentUser() user: User) {
    return this.paymentsService.getCustomerPortalUrl(user.id)
  }

  @Get('status')
  async status(@CurrentUser() user: User) {
    return this.subscriptionsService.getStatus(user.id)
  }
}
```

---

## WebhookModule

### `webhook.controller.ts`

**CRITICAL:** The webhook endpoint must receive the raw
request body as a Buffer — not a parsed JSON object.
NestJS body parser runs globally and converts bodies to
objects before your handler. This breaks webhook signature
verification.

Fix in `main.ts`:

```typescript
// main.ts — before app.listen()
// Exclude webhook route from global body parser:
app.use('/payments/webhook', express.raw({ type: '*/*' }))
```

```typescript
@Controller('payments')
export class WebhookController {
  @Post('webhook')
  async handleWebhook(
    @Headers('webhook-id')        webhookId:  string,
    @Headers('webhook-signature') signature:  string,
    @Headers('webhook-timestamp') timestamp:  string,
    @Req()                        req:        Request,
  ) {
    const rawBody = (req as any).rawBody ?? req.body

    // Verify signature using standardwebhooks
    try {
      const wh = new Webhook(this.config.get('DODO_WEBHOOK_SECRET'))
      await wh.verify(rawBody, {
        'webhook-id':        webhookId,
        'webhook-signature': signature,
        'webhook-timestamp': timestamp,
      })
    } catch (err) {
      throw new UnauthorizedException('Invalid webhook signature')
    }

    // Idempotency check — BEFORE any business logic
    const already = await this.prisma.processedWebhook.findUnique({
      where: { webhookId }
    })
    if (already) {
      return { status: 'already_processed' }
    }

    const event = JSON.parse(rawBody.toString())

    // Process inside a transaction with the idempotency record
    await this.webhookService.process(webhookId, event)

    return { status: 'ok' }
  }
}
```

### `webhook.service.ts` — every event handled

```typescript
@Injectable()
export class WebhookService {
  async process(webhookId: string, event: any): Promise<void> {

    // Wrap everything in a transaction
    // The idempotency record and business logic
    // succeed or fail together — never partial state
    await this.prisma.$transaction(async (tx) => {

      // Write idempotency record first
      await tx.processedWebhook.create({
        data: {
          webhookId,
          eventType: event.type,
        }
      })

      // Route to the correct handler
      switch (event.type) {

        case 'subscription.active':
          await this.onSubscriptionActive(tx, event)
          break

        case 'subscription.renewed':
          await this.onSubscriptionRenewed(tx, event)
          break

        case 'subscription.on_hold':
          await this.onSubscriptionOnHold(tx, event)
          break

        case 'subscription.cancelled':
          await this.onSubscriptionCancelled(tx, event)
          break

        case 'subscription.expired':
          await this.onSubscriptionExpired(tx, event)
          break

        case 'payment.succeeded':
          await this.onPaymentSucceeded(tx, event)
          break

        case 'payment.failed':
          await this.onPaymentFailed(tx, event)
          break

        case 'refund.succeeded':
          await this.onRefundSucceeded(tx, event)
          break

        case 'dispute.opened':
          await this.onDisputeOpened(tx, event)
          break

        case 'dispute.won':
          await this.onDisputeWon(tx, event)
          break

        case 'dispute.lost':
          await this.onDisputeLost(tx, event)
          break

        default:
          // Log unknown events — do not throw
          console.warn(`Unhandled webhook event: ${event.type}`)
      }
    })
  }

  // ─── subscription.active ────────────────────────────────

  private async onSubscriptionActive(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) throw new Error('No userId in metadata')

    const sub = await tx.subscription.upsert({
      where:  { userId },
      create: {
        userId,
        dodoCustomerId:    event.data.customer_id,
        dodoSubscriptionId: event.data.subscription_id,
        plan:              'PRO',
        status:            'ACTIVE',
        currency:          event.data.currency,
        priceAmount:       event.data.amount,
        currentPeriodStart: new Date(event.data.current_period_start),
        currentPeriodEnd:   new Date(event.data.current_period_end),
        gracePeriodEndsAt:  null,
      },
      update: {
        dodoCustomerId:    event.data.customer_id,
        dodoSubscriptionId: event.data.subscription_id,
        plan:              'PRO',
        status:            'ACTIVE',
        currency:          event.data.currency,
        priceAmount:       event.data.amount,
        currentPeriodStart: new Date(event.data.current_period_start),
        currentPeriodEnd:   new Date(event.data.current_period_end),
        gracePeriodEndsAt:  null,
        cancelledAt:        null,
      }
    })

    // Handle referral conversion
    await this.convertReferralIfExists(tx, userId)

    // Audit log
    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'subscription.upgraded',
        entity:   'Subscription',
        entityId: sub.id,
        after:    { plan: 'PRO', status: 'ACTIVE' },
        metadata: { source: 'webhook', eventType: event.type },
      }
    })

    // Send welcome email (outside transaction — fire and forget)
    this.emailService.sendProWelcome(userId).catch(console.error)
  }

  // ─── subscription.renewed ───────────────────────────────

  private async onSubscriptionRenewed(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) throw new Error('No userId in metadata')

    await tx.subscription.update({
      where: { userId },
      data:  {
        status:            'ACTIVE',
        currentPeriodStart: new Date(event.data.current_period_start),
        currentPeriodEnd:   new Date(event.data.current_period_end),
        gracePeriodEndsAt:  null,
      }
    })

    // Log payment
    await tx.payment.create({
      data: {
        userId,
        dodoPaymentId: event.data.payment_id,
        amount:        event.data.amount,
        currency:      event.data.currency,
        status:        'SUCCEEDED',
        type:          'SUBSCRIPTION_PAYMENT',
        metadata:      event.data,
      }
    })

    // No email on silent renewal — do not spam users
  }

  // ─── subscription.on_hold ───────────────────────────────

  private async onSubscriptionOnHold(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) throw new Error('No userId in metadata')

    const gracePeriodEndsAt = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000  // 3 days grace period
    )

    await tx.subscription.update({
      where: { userId },
      data:  {
        status:           'ON_HOLD',
        gracePeriodEndsAt,
      }
    })

    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'subscription.on_hold',
        entity:   'Subscription',
        entityId: userId,
        metadata: { gracePeriodEndsAt, reason: event.data.reason },
      }
    })

    // Send payment failure email
    this.emailService.sendPaymentFailed(userId, gracePeriodEndsAt)
      .catch(console.error)
  }

  // ─── subscription.cancelled ─────────────────────────────

  private async onSubscriptionCancelled(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) throw new Error('No userId in metadata')

    await tx.subscription.update({
      where: { userId },
      data:  {
        status:      'CANCELLED',
        cancelledAt: new Date(),
        // Keep currentPeriodEnd — user keeps access until then
      }
    })

    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'subscription.cancelled',
        entity:   'Subscription',
        entityId: userId,
        metadata: event.data,
      }
    })

    // Send cancellation confirmation email
    this.emailService.sendCancellationConfirmed(userId)
      .catch(console.error)
  }

  // ─── subscription.expired ───────────────────────────────

  private async onSubscriptionExpired(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) throw new Error('No userId in metadata')

    await tx.subscription.update({
      where: { userId },
      data:  {
        plan:   'FREE',
        status: 'EXPIRED',
      }
    })

    // DO NOT delete connected accounts
    // DO NOT remove existing file cache
    // Just update the plan — feature guard handles the rest

    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'subscription.downgraded',
        entity:   'Subscription',
        entityId: userId,
        before:   { plan: 'PRO' },
        after:    { plan: 'FREE' },
        metadata: event.data,
      }
    })

    this.emailService.sendSubscriptionExpired(userId)
      .catch(console.error)
  }

  // ─── payment.succeeded ──────────────────────────────────

  private async onPaymentSucceeded(tx: any, event: any) {
    // Just log — subscription events handle feature changes
    const userId = event.data.metadata?.userId
    if (!userId) return

    await tx.payment.upsert({
      where: { dodoPaymentId: event.data.payment_id },
      create: {
        userId,
        dodoPaymentId: event.data.payment_id,
        amount:        event.data.amount,
        currency:      event.data.currency,
        status:        'SUCCEEDED',
        type:          'SUBSCRIPTION_PAYMENT',
        metadata:      event.data,
      },
      update: {
        status:   'SUCCEEDED',
        metadata: event.data,
      }
    })
  }

  // ─── payment.failed ─────────────────────────────────────

  private async onPaymentFailed(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) return

    await tx.payment.create({
      data: {
        userId,
        dodoPaymentId: event.data.payment_id ?? `failed_${Date.now()}`,
        amount:        event.data.amount ?? 0,
        currency:      event.data.currency ?? 'NGN',
        status:        'FAILED',
        type:          'SUBSCRIPTION_PAYMENT',
        metadata:      event.data,
      }
    })
    // subscription.on_hold fires separately — do not duplicate logic
  }

  // ─── refund.succeeded ───────────────────────────────────

  private async onRefundSucceeded(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) throw new Error('No userId in metadata')

    // Log the refund
    await tx.payment.create({
      data: {
        userId,
        dodoPaymentId: event.data.refund_id,
        amount:        event.data.amount,
        currency:      event.data.currency,
        status:        'REFUNDED',
        type:          'REFUND',
        metadata:      event.data,
      }
    })

    // Downgrade to FREE immediately on refund
    await tx.subscription.update({
      where: { userId },
      data:  { plan: 'FREE', status: 'EXPIRED' }
    })

    // Revoke referral reward if this user was referred
    const referral = await tx.referral.findUnique({
      where: { referredUserId: userId }
    })
    if (referral?.rewardGranted && !referral?.rewardRevoked) {
      await tx.referral.update({
        where: { id: referral.id },
        data:  { status: 'REVOKED', rewardRevoked: true }
      })
      // Remove the bonus slot from the referrer
      await tx.user.update({
        where: { id: referral.referrerId },
        data:  { bonusSlots: { decrement: 1 } }
      })
      // Notify referrer their slot was revoked
      this.emailService.sendReferralRevoked(referral.referrerId)
        .catch(console.error)
    }

    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'payment.refunded',
        entity:   'Payment',
        entityId: userId,
        metadata: { refundId: event.data.refund_id, amount: event.data.amount },
      }
    })

    this.emailService.sendRefundConfirmed(userId).catch(console.error)
  }

  // ─── dispute.opened ─────────────────────────────────────

  private async onDisputeOpened(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) return

    // Flag the account — do not change subscription yet
    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'dispute.opened',
        entity:   'Payment',
        entityId: userId,
        metadata: { disputeId: event.data.dispute_id, reason: event.data.reason },
      }
    })

    // Send internal alert to admin (yourself)
    this.emailService.sendAdminAlert(
      'dispute.opened',
      `User ${userId} opened a dispute. Dispute ID: ${event.data.dispute_id}`
    ).catch(console.error)
  }

  // ─── dispute.won ────────────────────────────────────────

  private async onDisputeWon(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) return

    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'dispute.won',
        entity:   'Payment',
        entityId: userId,
        metadata: event.data,
      }
    })

    this.emailService.sendAdminAlert(
      'dispute.won',
      `Dispute won for user ${userId}`
    ).catch(console.error)
  }

  // ─── dispute.lost ───────────────────────────────────────

  private async onDisputeLost(tx: any, event: any) {
    const userId = event.data.metadata?.userId
    if (!userId) return

    // Downgrade immediately — payment was reversed by bank
    await tx.subscription.update({
      where: { userId },
      data:  { plan: 'FREE', status: 'EXPIRED' }
    })

    await tx.adminAuditLog.create({
      data: {
        userId,
        action:   'dispute.lost',
        entity:   'Payment',
        entityId: userId,
        metadata: event.data,
      }
    })

    this.emailService.sendAdminAlert(
      'dispute.lost',
      `Dispute lost for user ${userId}. User downgraded.`
    ).catch(console.error)
  }

  // ─── Referral conversion helper ─────────────────────────

  private async convertReferralIfExists(
    tx:     any,
    userId: string,
  ): Promise<void> {
    const referral = await tx.referral.findUnique({
      where: { referredUserId: userId }
    })

    if (!referral || referral.status !== 'PENDING') return

    // Check referrer has not exceeded the 3 bonus slot cap
    const referrer = await tx.user.findUnique({
      where: { id: referral.referrerId }
    })
    if (!referrer) return

    if (referrer.bonusSlots >= 3) {
      // Cap reached — convert but do not grant reward
      await tx.referral.update({
        where: { id: referral.id },
        data:  { status: 'CONVERTED', convertedAt: new Date() }
      })
      return
    }

    // Grant the reward
    await tx.referral.update({
      where: { id: referral.id },
      data:  {
        status:       'CONVERTED',
        rewardGranted: true,
        convertedAt:   new Date(),
      }
    })

    await tx.user.update({
      where: { id: referral.referrerId },
      data:  { bonusSlots: { increment: 1 } }
    })

    // Notify referrer
    this.emailService.sendReferralConverted(
      referral.referrerId,
      referrer.bonusSlots + 1
    ).catch(console.error)

    await tx.adminAuditLog.create({
      data: {
        userId:   referral.referrerId,
        action:   'referral.reward_granted',
        entity:   'Referral',
        entityId: referral.id,
        metadata: { referredUserId: userId, newBonusSlots: referrer.bonusSlots + 1 },
      }
    })
  }
}
```

---

## SubscriptionsModule

### `feature-guard.service.ts`

Every feature check in the app goes through this service.
Never check subscription status directly in controllers —
always use this service.

```typescript
export const PRO_FEATURES = [
  'move_files',
  'duplicate_detector',
  'bulk_operations',
  'storage_alerts',
  'storage_history',
  'upload_from_url',
  'file_preview',
  'connect_account_above_limit',
] as const

export type ProFeature = typeof PRO_FEATURES[number]

@Injectable()
export class FeatureGuardService {

  async canAccess(
    userId:  string,
    feature: ProFeature,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where:   { id: userId },
      include: { subscription: true },
    })
    if (!user) return false

    const isPro    = user.subscription?.plan === 'PRO'
    const isActive = user.subscription?.status === 'ACTIVE'
    const isOnHold = user.subscription?.status === 'ON_HOLD'

    // ON_HOLD users keep access during grace period
    const hasAccess = isPro && (isActive || isOnHold)

    if (hasAccess) return true

    // CANCELLED users keep access until period end
    if (user.subscription?.status === 'CANCELLED') {
      const periodEnd = user.subscription.currentPeriodEnd
      if (periodEnd && periodEnd > new Date()) return true
    }

    return false
  }

  async requireFeature(userId: string, feature: ProFeature): Promise<void> {
    const allowed = await this.canAccess(userId, feature)
    if (!allowed) {
      throw new ForbiddenException({
        code:    'FEATURE_LOCKED',
        feature,
        message: 'This feature requires a Pro subscription',
        upgradeUrl: '/pricing',
      })
    }
  }

  async getAccountLimit(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where:   { id: userId },
      include: { subscription: true },
    })
    if (!user) return 2

    const isPro = await this.canAccess(userId, 'connect_account_above_limit')
    if (isPro) return Infinity

    return 2 + (user.bonusSlots ?? 0)
  }
}
```

**Using the feature guard in services:**

```typescript
// In FilesService.moveFile():
await this.featureGuard.requireFeature(userId, 'move_files')
// rest of move logic

// In GoogleAccountsService.connectAccount():
const limit   = await this.featureGuard.getAccountLimit(userId)
const current = await this.prisma.connectedAccount.count({ where: { userId } })
if (current >= limit) {
  throw new ForbiddenException({
    code:    'FEATURE_LOCKED',
    feature: 'connect_account_above_limit',
    message: 'Upgrade to Pro to connect more than 2 accounts',
    upgradeUrl: '/pricing',
  })
}
```

---

## ReferralsModule

### `referrals.service.ts`

```typescript
@Injectable()
export class ReferralsService {

  // Generate a unique referral code for a user
  async getOrCreateReferralCode(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { referralCode: true, email: true },
    })

    if (user.referralCode) return user.referralCode

    // Generate a short code from the email prefix + random
    const prefix = user.email.split('@')[0].slice(0, 6).toUpperCase()
    const random = Math.random().toString(36).slice(2, 6).toUpperCase()
    const code   = `${prefix}${random}`

    await this.prisma.user.update({
      where: { id: userId },
      data:  { referralCode: code },
    })

    return code
  }

  // Called during user registration when a ref code is present
  async recordReferral(
    referralCode:  string,
    newUserId:     string,
    signupIp:      string,
  ): Promise<void> {
    const referrer = await this.prisma.user.findUnique({
      where: { referralCode }
    })

    // Silent fail — bad referral codes do not break signup
    if (!referrer) return
    if (referrer.id === newUserId) return  // cannot refer yourself

    // Check for suspicious IP — multiple signups from same IP
    const recentFromIp = await this.prisma.referral.count({
      where: {
        referredUser: { signupIp },
        createdAt:    { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    })

    // More than 3 signups from same IP in 24h — flag but do not block
    const isSuspicious = recentFromIp >= 3

    await this.prisma.referral.create({
      data: {
        referrerId:    referrer.id,
        referredUserId: newUserId,
        status:        'PENDING',
      }
    })

    if (isSuspicious) {
      await this.auditService.log({
        userId:   referrer.id,
        action:   'referral.suspicious_signup',
        entity:   'Referral',
        entityId: referrer.id,
        metadata: { signupIp, recentFromIp },
      })
    }
  }

  // Get referral stats for the current user
  async getStats(userId: string) {
    const code = await this.getOrCreateReferralCode(userId)

    const [referrals, user] = await Promise.all([
      this.prisma.referral.findMany({
        where:   { referrerId: userId },
        include: { referredUser: { select: { email: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.findUnique({
        where:  { id: userId },
        select: { bonusSlots: true },
      }),
    ])

    return {
      referralCode: code,
      referralUrl:  `${this.config.get('FRONTEND_URL')}/signup?ref=${code}`,
      bonusSlots:   user.bonusSlots,
      maxBonusSlots: 3,
      referrals:    referrals.map(r => ({
        email:       this.maskEmail(r.referredUser.email),
        status:      r.status,
        joinedAt:    r.referredUser.createdAt,
        convertedAt: r.convertedAt,
      })),
      totalPending:   referrals.filter(r => r.status === 'PENDING').length,
      totalConverted: referrals.filter(r => r.status === 'CONVERTED').length,
    }
  }

  // Expire referrals older than 30 days that never converted
  async expireStaleReferrals(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await this.prisma.referral.updateMany({
      where: {
        status:    'PENDING',
        createdAt: { lt: cutoff },
      },
      data: { status: 'EXPIRED' }
    })
  }

  private maskEmail(email: string): string {
    // Show first 2 chars + *** + domain: vi***@gmail.com
    const [local, domain] = email.split('@')
    return `${local.slice(0, 2)}***@${domain}`
  }
}
```

---

## AdminModule

### `admin.guard.ts`

```typescript
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req    = context.switchToHttp().getRequest()
    const secret = req.headers['x-admin-secret']
    return secret === process.env.ADMIN_SECRET
  }
}
```

### `admin.service.ts`

```typescript
@Injectable()
export class AdminService {

  // Manual upgrade a user to Pro
  async manualUpgrade(
    targetUserId: string,
    adminNote:    string,
    adminIp:      string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId }
    })
    if (!user) throw new NotFoundException()

    const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    await this.prisma.subscription.upsert({
      where:  { userId: targetUserId },
      create: {
        userId:            targetUserId,
        plan:              'PRO',
        status:            'ACTIVE',
        currentPeriodEnd:  endDate,
      },
      update: {
        plan:             'PRO',
        status:           'ACTIVE',
        currentPeriodEnd: endDate,
      }
    })

    await this.auditService.log({
      userId:   targetUserId,
      action:   'admin.user_upgraded_manually',
      entity:   'Subscription',
      entityId: targetUserId,
      metadata: { adminNote, periodEnd: endDate },
      ipAddress: adminIp,
    })
  }

  // Update pricing — changes the product ID and logs the change
  async updatePricing(
    dto:     UpdatePricingDto,
    adminIp: string,
  ): Promise<void> {
    const existing = await this.prisma.pricingConfig.findUnique({
      where: { key: dto.key }
    })

    await this.prisma.pricingConfig.upsert({
      where:  { key: dto.key },
      create: {
        key:       dto.key,
        productId: dto.productId,
        amount:    dto.amount,
        currency:  dto.currency,
        interval:  dto.interval ?? 'month',
        isActive:  true,
      },
      update: {
        productId: dto.productId,
        amount:    dto.amount,
        currency:  dto.currency,
        interval:  dto.interval ?? 'month',
        isActive:  true,
      }
    })

    await this.auditService.log({
      action:   'admin.pricing_updated',
      entity:   'PricingConfig',
      entityId: dto.key,
      before:   existing ?? {},
      after:    dto,
      metadata: { adminIp },
    })
  }

  // Get audit log with filters
  async getAuditLog(params: {
    userId?:   string
    action?:   string
    from?:     Date
    to?:       Date
    page?:     number
    limit?:    number
  }) {
    const { userId, action, from, to, page = 1, limit = 50 } = params

    const where: any = {}
    if (userId) where.userId = userId
    if (action) where.action = { contains: action }
    if (from || to) where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to   ? { lte: to   } : {}),
    }

    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip:    (page - 1) * limit,
        take:    limit,
        include: {
          user: { select: { email: true, displayName: true } }
        }
      }),
      this.prisma.adminAuditLog.count({ where }),
    ])

    return {
      data: logs,
      meta: { total, page, limit, lastPage: Math.ceil(total / limit) }
    }
  }

  // Get revenue summary
  async getRevenueSummary() {
    const [totalSucceeded, totalRefunded, activeSubscriptions] =
      await Promise.all([
        this.prisma.payment.aggregate({
          where:   { status: 'SUCCEEDED' },
          _sum:    { amount: true },
          _count:  true,
        }),
        this.prisma.payment.aggregate({
          where:   { status: 'REFUNDED' },
          _sum:    { amount: true },
          _count:  true,
        }),
        this.prisma.subscription.count({
          where: { plan: 'PRO', status: 'ACTIVE' }
        }),
      ])

    return {
      totalRevenue:        totalSucceeded._sum.amount ?? 0,
      totalTransactions:   totalSucceeded._count,
      totalRefunded:       totalRefunded._sum.amount ?? 0,
      activeSubscriptions,
    }
  }
}
```

### `admin.controller.ts`

```typescript
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {

  @Post('users/:userId/upgrade')
  async manualUpgrade(
    @Param('userId') userId: string,
    @Body()          dto:    ManualUpgradeDto,
    @Req()           req:    Request,
  ) {
    return this.adminService.manualUpgrade(userId, dto.note, req.ip)
  }

  @Put('pricing')
  async updatePricing(
    @Body() dto: UpdatePricingDto,
    @Req()  req: Request,
  ) {
    return this.adminService.updatePricing(dto, req.ip)
  }

  @Get('audit-log')
  async getAuditLog(@Query() query: AuditLogQueryDto) {
    return this.adminService.getAuditLog(query)
  }

  @Get('revenue')
  async getRevenue() {
    return this.adminService.getRevenueSummary()
  }

  @Get('users')
  async getUsers(@Query() query: AdminUserQueryDto) {
    return this.adminService.getUsers(query)
  }
}
```

---

## Scheduled jobs for payments

Add to `CleanupService` (JobsModule):

```typescript
// Expire stale referrals — daily
@Cron('0 1 * * *')
async expireReferrals() {
  await this.referralsService.expireStaleReferrals()
}

// Check grace period expirations — every hour
@Cron('0 * * * *')
async checkGracePeriods() {
  const expired = await this.prisma.subscription.findMany({
    where: {
      status:           'ON_HOLD',
      gracePeriodEndsAt: { lt: new Date() }
    }
  })

  for (const sub of expired) {
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data:  { plan: 'FREE', status: 'EXPIRED' }
    })

    await this.auditService.log({
      userId:   sub.userId,
      action:   'subscription.grace_period_expired',
      entity:   'Subscription',
      entityId: sub.id,
    })

    this.emailService.sendGracePeriodExpired(sub.userId)
      .catch(console.error)
  }
}

// Expire CANCELLED subscriptions past period end — daily
@Cron('0 2 * * *')
async expireCancelledSubscriptions() {
  await this.prisma.subscription.updateMany({
    where: {
      status:          'CANCELLED',
      currentPeriodEnd: { lt: new Date() }
    },
    data: { plan: 'FREE', status: 'EXPIRED' }
  })
}

// Clean up old idempotency records — weekly
@Cron('0 3 * * 0')
async cleanProcessedWebhooks() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  await this.prisma.processedWebhook.deleteMany({
    where: { processedAt: { lt: cutoff } }
  })
}
```

---

## Security improvements

### Rate limiting (add to existing setup)

```typescript
// Stricter limits on payment endpoints
@Throttle({ default: { limit: 3, ttl: 60000 } })
@Post('checkout')
async createCheckout() { ... }

// Webhook endpoint — no rate limit
// It is called by Dodo's servers not users
```

### SSRF protection on upload-from-URL

```typescript
function isSafeUrl(urlString: string): boolean {
  const url     = new URL(urlString)
  const blocked = [
    'localhost', '127.0.0.1', '0.0.0.0',
    '169.254.169.254',     // AWS metadata
    '192.168.', '10.', '172.16.',  // private ranges
  ]
  return !blocked.some(b => url.hostname.startsWith(b))
}
```

### Helmet configuration (update existing)

```typescript
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      frameSrc:   ["'self'", 'drive.google.com'],  // for file preview
    }
  },
  hsts: {
    maxAge:            31536000,
    includeSubDomains: true,
  }
}))
```

### Admin endpoint protection

The admin endpoints are protected by `ADMIN_SECRET` header.
This is a simple but effective protection for a solo project.

For production: add IP allowlisting on the admin routes —
only allow requests from your own IP address.

```typescript
// admin.guard.ts — add IP check
const allowedIps = (process.env.ADMIN_ALLOWED_IPS ?? '').split(',')
if (allowedIps.length && !allowedIps.includes(req.ip)) {
  return false
}
```

---

## AppModule additions

```typescript
@Module({
  imports: [
    // ... existing ...
    EventEmitterModule.forRoot(),
    PaymentsModule,
    SubscriptionsModule,
    ReferralsModule,
    AdminModule,
  ],
})
```

---

## Edge cases checklist

```
Payment:
  [ ] User tries to checkout when already Pro → 409 Conflict
  [ ] Same webhook fires twice → idempotency check returns early
  [ ] Webhook arrives before user record exists → log and skip
  [ ] Dodo API is down during checkout → 503 with retry message
  [ ] Amount in webhook does not match expected → log discrepancy

Referral:
  [ ] User refers themselves → rejected silently
  [ ] Referrer has reached 3 slot cap → convert but no reward
  [ ] Referred user refunds → reward revoked from referrer
  [ ] Bad referral code on signup → ignored, signup proceeds
  [ ] Same IP signs up 3+ times in 24h → flagged in audit log

Subscription:
  [ ] User cancels then resubscribes → treated as new subscription
  [ ] Grace period expires → downgrade runs even if webhook missed
  [ ] Cancelled subscription period ends → daily job catches it
  [ ] User deletes account mid-subscription → cancel with Dodo first
  [ ] Plan changes in PricingConfig → only affects new checkouts
      existing subscribers keep their current price

Feature access:
  [ ] ON_HOLD status → still has Pro access during grace period
  [ ] CANCELLED status within period → still has Pro access
  [ ] EXPIRED status → feature guard returns false on all Pro features
  [ ] Free user with 3 bonus slots → can connect 5 accounts total
```
