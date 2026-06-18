# Country Detection & Currency Display — Prompt Addition
# Applies to: payment-backend-prompt + payment-frontend-prompt
# Add this to both prompts as a new section

---

## IMPORTANT — READ FIRST

This prompt is an addition to the existing backend and
frontend payment prompts. Do not change anything that
already exists. Only add the new country detection and
currency display logic described here.

---

---

# BACKEND ADDITIONS

---

## New package

```bash
npm install ipapi.co
```

Or use native fetch — no package needed. ipapi.co works
with a plain GET request and no API key.

---

## New environment variable

```env
# Optional — only needed when you outgrow ipapi.co free tier
# and switch to ipinfo.io (50,000 requests/month free)
IPINFO_TOKEN=
```

---

## New service — `GeoService`

Create `src/common/geo/geo.service.ts`:

```typescript
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name)

  async detectCountry(ip: string): Promise<string> {
    // Skip detection for local/private IPs
    if (this.isPrivateIp(ip)) return 'UNKNOWN'

    try {
      // ipapi.co — free, no API key, 1000 req/day
      // Returns plain text: "NG", "US", "GB" etc.
      const res = await fetch(
        `https://ipapi.co/${ip}/country/`,
        {
          headers: { 'User-Agent': 'DriveStack/1.0' },
          signal:  AbortSignal.timeout(3000),  // 3s timeout
        }
      )

      if (!res.ok) throw new Error(`ipapi.co returned ${res.status}`)

      const country = (await res.text()).trim().toUpperCase()

      // Validate — should be a 2-letter ISO code
      if (!/^[A-Z]{2}$/.test(country)) {
        this.logger.warn(`Invalid country code from ipapi.co: ${country}`)
        return 'UNKNOWN'
      }

      return country

    } catch (err) {
      // Never let geo detection break signup
      // Log and return UNKNOWN — defaults to USD on frontend
      this.logger.warn(`Country detection failed for IP ${ip}: ${err.message}`)
      return 'UNKNOWN'
    }
  }

  getCurrency(country: string): 'NGN' | 'USD' {
    return country === 'NG' ? 'NGN' : 'USD'
  }

  private isPrivateIp(ip: string): boolean {
    return (
      ip === '127.0.0.1'          ||
      ip === '::1'                ||
      ip.startsWith('192.168.')   ||
      ip.startsWith('10.')        ||
      ip.startsWith('172.16.')    ||
      ip.startsWith('172.17.')    ||
      ip.startsWith('172.18.')    ||
      ip.startsWith('172.19.')    ||
      ip.startsWith('172.2')      ||
      ip.startsWith('172.3')      ||
      ip === 'localhost'          ||
      ip === '::ffff:127.0.0.1'
    )
  }
}
```

Register in `CommonModule` (or `AppModule`) and export.

---

## Update `AuthService.register()`

Add country detection to the registration flow.
Country is detected once and stored permanently.
Never call the geo API again for existing users.

```typescript
async register(
  dto: RegisterDto,
  ip:  string,
): Promise<{ user: User; token: string }> {

  // Check email uniqueness
  const existing = await this.prisma.user.findUnique({
    where: { email: dto.email }
  })
  if (existing) throw new ConflictException('Email already registered')

  // Hash password
  const passwordHash = await bcrypt.hash(dto.password, 12)

  // Detect country from IP — non-blocking, defaults to UNKNOWN
  const country = await this.geoService.detectCountry(ip)

  // Generate referral code
  const referralCode = await this.generateReferralCode(dto.email)

  // Create user
  const user = await this.prisma.user.create({
    data: {
      email:        dto.email,
      passwordHash,
      displayName:  dto.displayName ?? null,
      country,
      signupIp:     ip,
      referralCode,
    }
  })

  // Create a default FREE subscription record immediately
  // This ensures subscription checks never hit null
  await this.prisma.subscription.create({
    data: {
      userId: user.id,
      plan:   'FREE',
      status: 'ACTIVE',
    }
  })

  // Handle referral if code present
  if (dto.referralCode) {
    await this.referralsService.recordReferral(
      dto.referralCode,
      user.id,
      ip,
    )
  }

  // Audit log
  await this.auditService.log({
    userId:   user.id,
    action:   'user.registered',
    entity:   'User',
    entityId: user.id,
    metadata: { country, ip },
  })

  const token = this.jwtService.sign({
    sub:   user.id,
    email: user.email,
  })

  return { user: this.sanitizeUser(user), token }
}
```

**Extract IP correctly in `AuthController`:**

```typescript
@Post('register')
async register(
  @Body() dto: RegisterDto,
  @Req()  req: Request,
) {
  // Render and most reverse proxies set x-forwarded-for
  const ip = (
    req.headers['x-forwarded-for'] as string
    ?? req.socket.remoteAddress
    ?? '127.0.0.1'
  ).split(',')[0].trim()

  return this.authService.register(dto, ip)
}
```

---

## Update `RegisterDto`

Add optional `referralCode` field:

```typescript
export class RegisterDto {
  @IsEmail()
  email: string

  @IsString()
  @MinLength(8)
  password: string

  @IsString()
  @IsOptional()
  @MaxLength(100)
  displayName?: string

  @IsString()
  @IsOptional()
  @MaxLength(20)
  referralCode?: string   // ← ADD THIS
}
```

---

## Add country override endpoint

Let users manually change their billing region.
Some Nigerian users will be on VPN and get detected as
a different country. Give them a way to fix it.

```
PATCH /auth/country    (protected)
```

```typescript
// In AuthController:
@Patch('country')
@UseGuards(JwtAuthGuard)
async updateCountry(
  @Body()        dto:  UpdateCountryDto,
  @CurrentUser() user: User,
) {
  await this.prisma.user.update({
    where: { id: user.id },
    data:  { country: dto.country }
  })

  await this.auditService.log({
    userId:   user.id,
    action:   'user.country_updated',
    entity:   'User',
    entityId: user.id,
    before:   { country: user.country },
    after:    { country: dto.country },
  })

  return { country: dto.country }
}

// UpdateCountryDto:
export class UpdateCountryDto {
  @IsString()
  @Length(2, 2)
  @IsIn(['NG', 'US', 'GB', 'CA', 'AU', 'GH', 'KE', 'ZA'])
  // Add more countries as needed
  // Keep the list explicit — do not accept arbitrary strings
  country: string
}
```

---

## Update `GET /auth/me` response

Include `country` and `currency` in the current user response
so the frontend never has to calculate currency itself:

```typescript
// In AuthService.getCurrentUser():
async getCurrentUser(userId: string) {
  const user = await this.prisma.user.findUnique({
    where:   { id: userId },
    include: { subscription: true },
  })

  return {
    id:          user.id,
    email:       user.email,
    displayName: user.displayName,
    avatarUrl:   user.avatarUrl,
    country:     user.country ?? 'UNKNOWN',
    currency:    this.geoService.getCurrency(user.country ?? 'UNKNOWN'),
    bonusSlots:  user.bonusSlots,
    referralCode: user.referralCode,
    subscription: {
      plan:            user.subscription?.plan   ?? 'FREE',
      status:          user.subscription?.status ?? 'ACTIVE',
      currentPeriodEnd: user.subscription?.currentPeriodEnd ?? null,
      gracePeriodEndsAt: user.subscription?.gracePeriodEndsAt ?? null,
    }
  }
}
```

The frontend receives `currency: "NGN"` or `currency: "USD"`
directly — no calculation needed on the client.

---

## Update `PaymentsService.createCheckoutSession()`

Remove the currency parameter from the DTO —
read it from the user's stored country instead:

```typescript
async createCheckoutSession(
  userId: string,
  ip:     string,
): Promise<{ checkoutUrl: string }> {

  const user = await this.prisma.user.findUnique({
    where:   { id: userId },
    include: { subscription: true },
  })

  // Derive currency from stored country — single source of truth
  const currency  = this.geoService.getCurrency(user.country ?? 'UNKNOWN')
  const productId = await this.getProductId(currency)

  // ... rest of checkout logic unchanged
}

private async getProductId(currency: 'NGN' | 'USD'): Promise<string> {
  // Check PricingConfig table first — allows admin price changes
  const config = await this.prisma.pricingConfig.findFirst({
    where: {
      key:      currency === 'NGN' ? 'pro_ngn' : 'pro_usd',
      isActive: true,
    }
  })

  if (config?.productId) return config.productId

  // Fallback to env vars
  const envKey = currency === 'NGN'
    ? 'DODO_PRO_PRODUCT_ID_NGN'
    : 'DODO_PRO_PRODUCT_ID_USD'

  const productId = this.config.get<string>(envKey)
  if (!productId) throw new InternalServerErrorException(
    `No product ID configured for currency: ${currency}`
  )

  return productId
}
```

---

---

# FRONTEND ADDITIONS

---

## Update auth store

Add `country` and `currency` to the auth store:

```typescript
// stores/auth.store.ts
interface AuthState {
  user:     User | null
  token:    string | null
  currency: 'NGN' | 'USD'   // ← ADD
  // ... existing fields
}

// currency derives from user.currency returned by /auth/me
// Default: 'USD' until user data loads
```

---

## New utility — `formatCurrency`

```typescript
// lib/utils/currency.ts

export function formatCurrency(
  amount:   number,
  currency: 'NGN' | 'USD',
): string {
  if (currency === 'NGN') {
    return `₦${amount.toLocaleString('en-NG')}`
  }
  return `$${amount.toFixed(2)}`
}

export function getMonthlyPrice(currency: 'NGN' | 'USD'): number {
  return currency === 'NGN' ? 800 : 1.99
}

export function getAnnualPrice(currency: 'NGN' | 'USD'): number {
  return currency === 'NGN' ? 6400 : 15.99
}

export function getAnnualSaving(currency: 'NGN' | 'USD'): number {
  const monthly = getMonthlyPrice(currency) * 12
  const annual  = getAnnualPrice(currency)
  return monthly - annual
}

export function getCurrencySymbol(currency: 'NGN' | 'USD'): string {
  return currency === 'NGN' ? '₦' : '$'
}
```

---

## Update PricingCards component

The pricing cards read currency from the auth store.
They show the correct prices without any manual switching:

```typescript
// components/billing/pricing-card.tsx
export function ProPricingCard({ isAnnual }: { isAnnual: boolean }) {
  const currency = useAuthStore(s => s.currency)

  const monthlyPrice = getMonthlyPrice(currency)
  const annualPrice  = getAnnualPrice(currency)
  const saving       = getAnnualSaving(currency)
  const symbol       = getCurrencySymbol(currency)

  return (
    <div className="...">
      <AnimatePresence mode="wait">
        <motion.div
          key={`${currency}-${isAnnual ? 'annual' : 'monthly'}`}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0  }}
          exit={{    opacity: 0, y:  8  }}
          transition={{ duration: 0.15 }}>

          <span className="text-5xl font-bold">
            {symbol}{isAnnual
              ? Math.round(annualPrice / 12)
              : monthlyPrice}
          </span>
          <span className="text-sm text-text-secondary">/month</span>

          {isAnnual && (
            <p className="text-sm text-text-secondary mt-1">
              Billed {symbol}{annualPrice}/year
              · Save {symbol}{saving}
            </p>
          )}

          {!isAnnual && currency === 'NGN' && (
            <p className="text-xs text-text-tertiary mt-1">
              International users: $1.99/month
            </p>
          )}

        </motion.div>
      </AnimatePresence>
    </div>
  )
}
```

The price animates in and out when the billing toggle switches
between monthly and annual. Smooth, not jarring.

---

## Update checkout button

Remove `currency` from the DTO — the backend reads it from
the user's stored country:

```typescript
// Before (wrong — passes currency from frontend):
await paymentsApi.createCheckout({ currency: 'NGN' })

// After (correct — backend determines currency from user.country):
await paymentsApi.createCheckout({})

// Update the API function:
export const paymentsApi = {
  createCheckout: (dto?: { isAnnual?: boolean }) =>
    api.post<{ checkoutUrl: string }>('/payments/checkout', dto ?? {}),
}
```

Currency is a server-side concern derived from the user's
stored country. The frontend never sends currency — it just
displays it.

---

## Country override in settings

Add to `/settings` page, in a "Billing region" section:

```tsx
// components/settings/billing-region.tsx

const REGIONS = [
  { code: 'NG', label: 'Nigeria',       currency: 'NGN', symbol: '₦' },
  { code: 'US', label: 'United States', currency: 'USD', symbol: '$' },
  { code: 'GB', label: 'United Kingdom',currency: 'USD', symbol: '$' },
  { code: 'GH', label: 'Ghana',         currency: 'USD', symbol: '$' },
  { code: 'KE', label: 'Kenya',         currency: 'USD', symbol: '$' },
  { code: 'ZA', label: 'South Africa',  currency: 'USD', symbol: '$' },
  { code: 'CA', label: 'Canada',        currency: 'USD', symbol: '$' },
  { code: 'AU', label: 'Australia',     currency: 'USD', symbol: '$' },
]

export function BillingRegionSelector() {
  const { user, setCurrency } = useAuthStore()
  const [selected, setSelected] = useState(user?.country ?? 'US')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await api.patch('/auth/country', { country: selected })
    // Refresh user data — currency updates automatically
    await refetchUser()
    toast.success('Billing region updated')
    setSaving(false)
  }

  const selectedRegion = REGIONS.find(r => r.code === selected)

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium text-text-primary">
          Billing region
        </label>
        <p className="text-xs text-text-tertiary mt-0.5">
          This determines which currency you are charged in.
          Nigerian users pay in Naira (₦).
          Everyone else pays in USD ($).
        </p>
      </div>

      <Select value={selected} onValueChange={setSelected}>
        {REGIONS.map(r => (
          <SelectItem key={r.code} value={r.code}>
            {r.label} · {r.symbol}
          </SelectItem>
        ))}
      </Select>

      {selectedRegion && (
        <p className="text-xs text-text-secondary">
          You will be charged in {selectedRegion.currency}
          ({selectedRegion.symbol}).
        </p>
      )}

      <Button
        onClick={handleSave}
        disabled={saving || selected === user?.country}
        size="sm">
        {saving ? 'Saving...' : 'Save region'}
      </Button>
    </div>
  )
}
```

---

## Update UpgradeModal

Show the correct currency dynamically:

```tsx
// Inside UpgradeModal — the price line:
const currency = useAuthStore(s => s.currency)
const price    = formatCurrency(getMonthlyPrice(currency), currency)

// Renders:
// Nigerian user:       ₦800/month · Cancel anytime
// International user:  $1.99/month · Cancel anytime
```

---

## Update PricingToggle

Show savings in the correct currency:

```tsx
export function PricingToggle({ isAnnual, onToggle }) {
  const currency = useAuthStore(s => s.currency)
  const saving   = getAnnualSaving(currency)
  const symbol   = getCurrencySymbol(currency)

  return (
    <div className="flex items-center gap-3">
      <span className={cn('text-sm', !isAnnual && 'font-medium')}>
        Monthly
      </span>

      <Switch checked={isAnnual} onCheckedChange={onToggle} />

      <span className={cn('text-sm', isAnnual && 'font-medium')}>
        Annual
        <span className="ml-2 rounded bg-black px-1.5 py-0.5
                         text-[10px] uppercase text-white">
          Save {symbol}{saving}
        </span>
      </span>
    </div>
  )
}
```

---

## Loading state for currency

While `GET /auth/me` is loading, the pricing cards should
show skeleton placeholders for the price — not a default
value that might flash the wrong currency:

```tsx
// In PricingCard while user data is loading:
{isLoadingUser ? (
  <Skeleton className="h-12 w-24" />
) : (
  <PriceDisplay currency={currency} isAnnual={isAnnual} />
)}
```

This prevents Nigerian users from briefly seeing "$1.99"
before the correct "₦800" loads. No currency flash.

---

## Edge cases for currency display

```
Undetected IP (UNKNOWN country):
  → Default to USD
  → Show region selector in settings
  → User can manually switch to NGN if they are Nigerian

Nigerian user on VPN:
  → Detected as non-NG → shows USD
  → Settings page has region selector
  → They change to Nigeria → immediately shows NGN

User changes region after subscribing:
  → Country field updates
  → UI shows new currency
  → Existing subscription stays at original currency
  → New subscription after cancellation uses new currency
  → Never change currency on a live subscription

ipapi.co rate limit hit (1000 req/day exceeded):
  → GeoService returns 'UNKNOWN' from the catch block
  → User defaults to USD
  → No signup failure
  → User can manually set region in settings
```

---

## Summary of all changes

| Layer | File | What changes |
|---|---|---|
| Backend | `common/geo/geo.service.ts` | New — IP detection service |
| Backend | `auth/auth.service.ts` | Detect country on register |
| Backend | `auth/auth.controller.ts` | Extract IP, add PATCH /country |
| Backend | `auth/dto/register.dto.ts` | Add optional referralCode |
| Backend | `auth/dto/update-country.dto.ts` | New DTO |
| Backend | `payments/payments.service.ts` | Read currency from user.country |
| Backend | `.env` | Add IPINFO_TOKEN (optional) |
| Frontend | `stores/auth.store.ts` | Add currency field |
| Frontend | `lib/utils/currency.ts` | New — price formatting utils |
| Frontend | `components/billing/pricing-card.tsx` | Read currency from store |
| Frontend | `components/billing/pricing-toggle.tsx` | Show saving in correct currency |
| Frontend | `components/billing/upgrade-modal.tsx` | Dynamic currency display |
| Frontend | `components/settings/billing-region.tsx` | New — region selector |
| Frontend | `lib/api/payments.api.ts` | Remove currency from checkout DTO |
