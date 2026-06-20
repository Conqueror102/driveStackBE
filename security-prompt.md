# Security Implementation Prompt — DriveStack
# Backend (NestJS) + Frontend (Next.js)
# Consolidated — all security concerns in one file

---

## IMPORTANT — READ FIRST

This prompt consolidates every security requirement for
DriveStack into one implementation guide. Read all of it
before writing any code. Many items here update or correct
things that may already exist in the codebase. Check each
section against what is already built and fill the gaps.

Do not skip any section. Security is not optional.

---

## Threat model — what you are protecting against

```
1. OAuth tokens         → full access to user's Google Drive
2. User accounts        → impersonate user, access their files
3. JWT tokens           → hijack authenticated sessions
4. Payment webhooks     → fake payments, double-crediting
5. Referral abuse       → fake accounts to farm bonus slots
6. SSRF attacks         → server fetches internal URLs
7. Brute force          → repeated login/register attempts
8. Data leakage         → tokens/secrets in logs or responses
9. CSRF on OAuth        → connect attacker's Google account
10. Admin access        → unauthorised access to admin panel
```

These ten threats define every security decision below.

---

---

# BACKEND SECURITY

---

## 1. Startup validation

Validate all critical environment variables before the app
accepts any traffic. If any are missing or weak — crash
immediately. A misconfigured app in production is worse
than no app.

```typescript
// main.ts — add before app.listen()
function validateEnvironment() {
  const required = [
    'DATABASE_URL',
    'JWT_SECRET',
    'ENCRYPTION_KEY',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'DODO_API_KEY',
    'DODO_WEBHOOK_SECRET',
    'FRONTEND_URL',
    'ADMIN_SECRET',
  ]

  const missing = required.filter(key => !process.env[key])
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    )
  }

  // JWT_SECRET must be at least 32 characters
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters')
  }

  // ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)
  if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY)) {
    throw new Error(
      'ENCRYPTION_KEY must be exactly 64 lowercase hex characters. ' +
      'Generate with: openssl rand -hex 32'
    )
  }

  // ADMIN_SECRET must be at least 32 characters
  if (process.env.ADMIN_SECRET.length < 32) {
    throw new Error('ADMIN_SECRET must be at least 32 characters')
  }
}

// Call before bootstrap:
validateEnvironment()
await app.listen(process.env.PORT ?? 4000)
```

---

## 2. Token encryption — AES-256-GCM

All OAuth access tokens and refresh tokens must be encrypted
before writing to the database. Raw tokens in the database
mean a DB breach = full Drive access for every user.

### CryptoService — complete implementation

```typescript
// src/common/crypto/crypto.service.ts
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto'

@Injectable()
export class CryptoService {
  private readonly key: Buffer

  constructor(private config: ConfigService) {
    const hexKey = this.config.get<string>('ENCRYPTION_KEY')
    this.key = Buffer.from(hexKey, 'hex')

    // Validate key length on startup
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes')
    }
  }

  encrypt(plaintext: string): string {
    const iv       = randomBytes(16)
    const cipher   = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ])
    const authTag = cipher.getAuthTag()

    // Pack: [iv (16 bytes)] + [authTag (16 bytes)] + [ciphertext]
    return Buffer.concat([iv, authTag, encrypted]).toString('base64')
  }

  decrypt(stored: string): string {
    try {
      const buf        = Buffer.from(stored, 'base64')
      const iv         = buf.subarray(0, 16)
      const authTag    = buf.subarray(16, 32)
      const ciphertext = buf.subarray(32)

      const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
      decipher.setAuthTag(authTag)

      return (
        decipher.update(ciphertext).toString('utf8') +
        decipher.final('utf8')
      )
    } catch {
      // Never expose crypto errors — they leak information
      throw new InternalServerErrorException('Token decryption failed')
    }
  }
}
```

### Rules for token storage

```typescript
// ALWAYS encrypt before writing:
await this.prisma.connectedAccount.create({
  data: {
    accessToken:  this.crypto.encrypt(rawAccessToken),   // ✓
    refreshToken: this.crypto.encrypt(rawRefreshToken),  // ✓
  }
})

// NEVER write raw tokens:
await this.prisma.connectedAccount.create({
  data: {
    accessToken:  rawAccessToken,   // ✗ NEVER
    refreshToken: rawRefreshToken,  // ✗ NEVER
  }
})

// ALWAYS decrypt before use:
const accessToken = this.crypto.decrypt(account.accessToken)

// NEVER log tokens — not even the encrypted form:
console.log('Token:', account.accessToken)   // ✗ NEVER
console.log('Account ID:', account.id)       // ✓ log IDs only
```

---

## 3. Token revocation on account events

### On account disconnect

```typescript
// google-accounts.service.ts
async disconnectAccount(userId: string, accountId: string): Promise<void> {
  const account = await this.prisma.connectedAccount.findFirst({
    where: { id: accountId, userId }
  })
  if (!account) throw new ForbiddenException()

  const refreshToken = this.crypto.decrypt(account.refreshToken)

  // Revoke with Google first — invalidates both tokens on Google's side
  try {
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${refreshToken}`,
      { method: 'POST' }
    )
  } catch (err) {
    // Log but do not block deletion — DB cleanup must still happen
    console.error('Token revocation failed:', err.message)
  }

  // Then delete from DB — do NOT just mark inactive
  await this.prisma.connectedAccount.delete({
    where: { id: accountId }
  })

  await this.auditService.log({
    userId,
    action:   'account.disconnected',
    entity:   'ConnectedAccount',
    entityId: accountId,
  })
}
```

### On full account deletion

```typescript
// auth.service.ts
async deleteAccount(userId: string): Promise<void> {
  const accounts = await this.prisma.connectedAccount.findMany({
    where: { userId }
  })

  // Revoke all Google tokens
  await Promise.allSettled(
    accounts.map(async (account) => {
      const refreshToken = this.crypto.decrypt(account.refreshToken)
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${refreshToken}`,
        { method: 'POST' }
      ).catch(err =>
        console.error(`Revoke failed for ${account.id}:`, err.message)
      )
    })
  )

  // Cancel active subscription with Dodo
  const sub = await this.prisma.subscription.findUnique({
    where: { userId }
  })
  if (sub?.dodoSubscriptionId && sub.plan === 'PRO') {
    await this.dodoClient.cancelSubscription(sub.dodoSubscriptionId)
      .catch(err =>
        console.error('Subscription cancellation failed:', err.message)
      )
  }

  // Delete user — cascades handle connected accounts,
  // file cache, upload sessions, notifications, referrals
  await this.prisma.user.delete({ where: { id: userId } })

  await this.auditService.log({
    userId,
    action:   'user.account_deleted',
    entity:   'User',
    entityId: userId,
  })
}
```

---

## 4. JWT security

```typescript
// auth.service.ts — token signing
sign(userId: string, email: string): string {
  return this.jwtService.sign(
    { sub: userId, email },
    {
      secret:    this.config.get('JWT_SECRET'),
      expiresIn: '7d',
      algorithm: 'HS256',
    }
  )
}

// jwt.strategy.ts — token validation
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private config:  ConfigService,
    private prisma:  PrismaService,
  ) {
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey:      config.get<string>('JWT_SECRET'),
      ignoreExpiration: false,  // ALWAYS false
    })
  }

  async validate(payload: { sub: string; email: string }) {
    // Validate the user still exists — account may have been deleted
    const user = await this.prisma.user.findUnique({
      where:   { id: payload.sub },
      include: { subscription: true },
    })

    if (!user) throw new UnauthorizedException('User no longer exists')

    return user  // attached to request.user
  }
}
```

**JWT secret rotation (every 90 days in production):**

When you rotate `JWT_SECRET`, all existing tokens become
invalid immediately. All users will be logged out. Plan for
this — announce maintenance, rotate the key, users log back in.
There is no graceful rotation without a token blacklist.
For your current scale, forced re-login on rotation is acceptable.

---

## 5. Password security

```typescript
// auth.service.ts

// Hashing — cost factor 12
const passwordHash = await bcrypt.hash(password, 12)
// Cost factor below 10 is not acceptable in production.
// Cost factor above 12 is not needed at your scale.

// Verification
const isValid = await bcrypt.compare(plainPassword, storedHash)
if (!isValid) throw new UnauthorizedException('Invalid credentials')

// Password never appears in:
// - Logs
// - Error messages
// - API responses
// - Audit log metadata
```

---

## 6. Rate limiting

Install:
```bash
npm install @nestjs/throttler
```

Register globally in `AppModule`:

```typescript
ThrottlerModule.forRoot([{
  ttl:   60000,  // 1 minute window
  limit: 100,    // 100 requests per minute default
}])
```

Then apply stricter limits to sensitive endpoints:

```typescript
// auth.controller.ts
@Throttle({ default: { limit: 5, ttl: 60000 } })
@Post('login')
async login() { ... }
// 5 login attempts per minute — prevents brute force

@Throttle({ default: { limit: 3, ttl: 60000 } })
@Post('register')
async register() { ... }
// 3 registrations per minute per IP

@Throttle({ default: { limit: 3, ttl: 60000 } })
@Post('checkout')
async createCheckout() { ... }
// 3 checkout attempts per minute

// Webhook endpoint — no rate limit
// It is called by Dodo's servers, not users
// Add Dodo's IP range to an allowlist instead (see section 9)
```

Apply the global throttle guard:
```typescript
// app.module.ts providers:
{ provide: APP_GUARD, useClass: ThrottlerGuard }
```

---

## 7. OAuth state parameter — CSRF protection

Without this, an attacker can trick a user into connecting
the attacker's Google account to the victim's DriveStack account.

The `state` parameter must be a random one-time token —
not the userId directly.

```typescript
// google-auth.service.ts
async getAuthUrl(userId: string): Promise<string> {
  // Random 32-byte token
  const stateToken = randomBytes(32).toString('hex')

  // Store in Redis with 5 minute TTL
  // After 5 minutes the OAuth window expires
  await this.redis.setex(
    `oauth:state:${stateToken}`,
    300,
    userId
  )

  return this.oauth2Client.generateAuthUrl({
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    state:       stateToken,   // ← random token not userId
    access_type: 'offline',
    prompt:      'consent',    // always get refresh token
  })
}

// google-accounts.controller.ts — callback handler
@Get('callback')
async handleCallback(
  @Query('code')  code:  string,
  @Query('state') state: string,
  @Res()          res:   Response,
) {
  if (!code || !state) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/accounts?error=missing_params`
    )
  }

  // Verify state token — get userId from Redis
  const userId = await this.redis.get(`oauth:state:${state}`)

  if (!userId) {
    // State token expired or was never valid
    return res.redirect(
      `${process.env.FRONTEND_URL}/accounts?error=invalid_state`
    )
  }

  // Delete immediately — one use only
  await this.redis.del(`oauth:state:${state}`)

  try {
    await this.googleAccountsService.connectAccount(userId, code)
    res.redirect(`${process.env.FRONTEND_URL}/accounts?connected=true`)
  } catch (err) {
    res.redirect(
      `${process.env.FRONTEND_URL}/accounts?error=oauth_failed`
    )
  }
}
```

---

## 8. Input validation — all DTOs

Every DTO must have complete class-validator decorators.
The global `ValidationPipe` (already registered in main.ts)
rejects requests that fail validation before they hit the controller.

```typescript
// Ensure this is in main.ts:
app.useGlobalPipes(new ValidationPipe({
  whitelist:            true,   // strip unknown properties
  forbidNonWhitelisted: true,   // reject unknown properties
  transform:            true,
  transformOptions: { enableImplicitConversion: true },
}))

// Example — CreateUploadSessionDto:
export class CreateUploadSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  fileName: string

  @IsString()
  @IsNotEmpty()
  @Matches(
    /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/
  )
  mimeType: string

  @IsString()
  @Matches(/^\d+$/)  // BigInt as string — digits only
  fileSize: string

  @IsString()
  @IsNotEmpty()
  @IsUUID()
  accountId: string
}

// Example — RegisterDto:
export class RegisterDto {
  @IsEmail()
  @MaxLength(255)
  email: string

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string

  @IsString()
  @IsOptional()
  @MaxLength(100)
  displayName?: string

  @IsString()
  @IsOptional()
  @MaxLength(20)
  referralCode?: string
}
```

---

## 9. SSRF protection — upload from URL

Without this, someone can pass internal URLs to your upload
endpoint and have your server make requests to:
- `http://localhost:5432` (your database)
- `http://169.254.169.254` (AWS metadata — exposes cloud credentials)
- `http://192.168.x.x` (internal network)

```typescript
// src/common/utils/safe-url.ts

export function assertSafeUrl(urlString: string): void {
  let parsed: URL

  try {
    parsed = new URL(urlString)
  } catch {
    throw new BadRequestException('Invalid URL format')
  }

  // Only allow HTTP and HTTPS
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Only HTTP and HTTPS URLs are allowed')
  }

  const hostname = parsed.hostname.toLowerCase()

  const blockedHostnames = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '169.254.169.254',    // AWS/GCP/Azure metadata
    'metadata.google.internal',
  ]

  const blockedPrefixes = [
    '192.168.',
    '10.',
    '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.',
    '172.24.', '172.25.', '172.26.', '172.27.',
    '172.28.', '172.29.', '172.30.', '172.31.',
    'fd',   // IPv6 private
    'fe80', // IPv6 link-local
  ]

  if (blockedHostnames.includes(hostname)) {
    throw new BadRequestException('URL not allowed')
  }

  if (blockedPrefixes.some(prefix => hostname.startsWith(prefix))) {
    throw new BadRequestException('URL not allowed')
  }
}

// Use in UploadFromUrlDto:
export class UploadFromUrlDto {
  @IsUrl({
    protocols:        ['http', 'https'],
    require_protocol: true,
  })
  @IsNotEmpty()
  @MaxLength(2048)
  url: string

  @IsString()
  @IsOptional()
  @MaxLength(255)
  fileName?: string

  @IsString()
  @IsNotEmpty()
  @IsUUID()
  accountId: string
}

// And at the start of uploadFromUrl service method:
assertSafeUrl(dto.url)
```

---

## 10. Ownership checks — the universal rule

Every service method that touches a user-owned resource
must verify ownership. Return 403 — not 404 — on mismatch.
Returning 404 tells the attacker the resource exists.

```typescript
// The pattern — use this everywhere:
private async getOwnedAccount(
  userId:    string,
  accountId: string,
): Promise<ConnectedAccount> {
  const account = await this.prisma.connectedAccount.findFirst({
    where: { id: accountId, userId }  // userId is ALWAYS in the where
  })

  // 403 not 404 — do not reveal whether the resource exists
  if (!account) throw new ForbiddenException()

  return account
}

// Apply to:
// - getOwnedAccount(userId, accountId)
// - getOwnedFile(userId, accountId, fileId)
// - getOwnedUploadSession(userId, sessionId)
// - getOwnedMoveOperation(userId, operationId)
// - getOwnedReferral(userId, referralId)
```

---

## 11. Security headers — Helmet

```typescript
// main.ts
import helmet from 'helmet'

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      frameSrc:   [
        "'self'",
        'drive.google.com',   // file preview iframes
        'docs.google.com',
      ],
      frameAncestors: ["'none'"],  // prevent clickjacking
    }
  },
  hsts: {
    maxAge:            31536000,  // 1 year
    includeSubDomains: true,
    preload:           true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff:        true,
  frameguard:     { action: 'deny' },
  xssFilter:      true,
}))
```

---

## 12. CORS — restrict to frontend only

```typescript
// main.ts
app.enableCors({
  origin:      process.env.FRONTEND_URL,  // exact URL only
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'webhook-id',
    'webhook-signature',
    'webhook-timestamp',
  ],
})
```

Never use `origin: '*'` in production. The wildcard allows
any website to make credentialed requests to your API.

---

## 13. Logging — never log sensitive data

```typescript
// src/common/logger/safe-logger.service.ts
@Injectable()
export class SafeLoggerService {
  private readonly logger = new Logger()

  // Fields that must never appear in logs
  private readonly SENSITIVE_FIELDS = [
    'password', 'passwordHash',
    'accessToken', 'refreshToken',
    'token', 'secret', 'key',
    'authorization', 'x-admin-secret',
  ]

  sanitize(data: any): any {
    if (typeof data !== 'object' || data === null) return data

    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        this.SENSITIVE_FIELDS.some(f =>
          key.toLowerCase().includes(f.toLowerCase())
        )
          ? '[REDACTED]'
          : value,
      ])
    )
  }

  log(message: string, context?: any) {
    this.logger.log(message, context ? this.sanitize(context) : undefined)
  }

  error(message: string, context?: any) {
    this.logger.error(message, context ? this.sanitize(context) : undefined)
  }
}
```

---

## 14. Webhook security — Dodo Payments

Three layers are required. All three must be present.

### Layer 1 — Raw body

NestJS body parser parses the request body before your
handler runs, breaking signature verification. The webhook
endpoint needs the raw bytes.

```typescript
// main.ts — before app.use(express.json())
app.use('/payments/webhook', express.raw({ type: '*/*' }))

// Then register global JSON parser for everything else:
app.use(express.json())
```

### Layer 2 — Signature verification

```typescript
// webhook.controller.ts
import { Webhook } from 'standardwebhooks'

@Post('webhook')
async handleWebhook(
  @Headers('webhook-id')        webhookId:  string,
  @Headers('webhook-signature') signature:  string,
  @Headers('webhook-timestamp') timestamp:  string,
  @Req()                        req:        RawBodyRequest<Request>,
) {
  const rawBody = req.rawBody ?? req.body

  if (!webhookId || !signature || !timestamp) {
    throw new UnauthorizedException('Missing webhook headers')
  }

  try {
    const wh = new Webhook(process.env.DODO_WEBHOOK_SECRET)
    await wh.verify(rawBody.toString(), {
      'webhook-id':        webhookId,
      'webhook-signature': signature,
      'webhook-timestamp': timestamp,
    })
  } catch {
    // Never expose why verification failed
    throw new UnauthorizedException('Webhook verification failed')
  }

  // Layer 3 — idempotency check before any business logic
  const already = await this.prisma.processedWebhook.findUnique({
    where: { webhookId }
  })
  if (already) return { status: 'already_processed' }

  const event = JSON.parse(rawBody.toString())
  await this.webhookService.process(webhookId, event)

  return { status: 'ok' }
}
```

### Layer 3 — Timestamp validation

Reject webhooks with timestamps older than 5 minutes.
This prevents replay attacks where someone captures a
valid webhook and resends it later.

```typescript
// Add inside the webhook handler after signature verification:
const webhookTimestamp = parseInt(timestamp, 10)
const now             = Math.floor(Date.now() / 1000)
const fiveMinutes     = 5 * 60

if (Math.abs(now - webhookTimestamp) > fiveMinutes) {
  throw new UnauthorizedException('Webhook timestamp too old')
}
```

---

## 15. Admin authentication — no secrets on frontend

The admin panel never uses a shared secret header from the
browser. The flow is:

```
Admin visits /admin/login
  → enters ADMIN_PASSWORD (set as env var)
  → POST /admin/auth { password }

NestJS AdminAuthService:
  → compares against process.env.ADMIN_SECRET
  → if correct → signs a short-lived admin JWT (4 hours)
  → returns { adminToken }

Frontend stores adminToken in Zustand (memory only)
  → never localStorage
  → never sessionStorage
  → lost on page refresh (intentional — forces re-login)

All admin API calls use:
  Authorization: Bearer <adminToken>

AdminGuard validates the admin JWT:
  → not a shared secret
  → expiry checked automatically
  → different signing key from user JWT
```

### NestJS admin auth

```typescript
// admin/admin-auth.service.ts
@Injectable()
export class AdminAuthService {
  constructor(
    private jwtService:    JwtService,
    private config:        ConfigService,
    private auditService:  AdminAuditService,
  ) {}

  async login(
    password:  string,
    ipAddress: string,
  ): Promise<{ adminToken: string }> {

    const adminSecret = this.config.get<string>('ADMIN_SECRET')

    // Use timing-safe comparison to prevent timing attacks
    const passwordBuffer = Buffer.from(password)
    const secretBuffer   = Buffer.from(adminSecret)

    const isValid =
      passwordBuffer.length === secretBuffer.length &&
      timingSafeEqual(passwordBuffer, secretBuffer)

    if (!isValid) {
      await this.auditService.log({
        action:    'admin.login_failed',
        entity:    'Admin',
        entityId:  'admin',
        metadata:  { ipAddress },
        ipAddress,
      })
      throw new UnauthorizedException('Invalid admin password')
    }

    const adminToken = this.jwtService.sign(
      { role: 'admin', sub: 'admin' },
      {
        secret:    `${adminSecret}_admin`,  // different from user JWT secret
        expiresIn: '4h',
      }
    )

    await this.auditService.log({
      action:    'admin.login_success',
      entity:    'Admin',
      entityId:  'admin',
      metadata:  { ipAddress },
      ipAddress,
    })

    return { adminToken }
  }
}

// admin/guards/admin-jwt.guard.ts
@Injectable()
export class AdminJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req   = context.switchToHttp().getRequest()
    const token = req.headers.authorization?.split(' ')[1]

    if (!token) throw new UnauthorizedException()

    try {
      const payload = this.jwtService.verify(token, {
        secret: `${process.env.ADMIN_SECRET}_admin`,
      })
      if (payload.role !== 'admin') throw new UnauthorizedException()
      return true
    } catch {
      throw new UnauthorizedException('Invalid admin token')
    }
  }
}
```

Rate limit the admin login endpoint strictly:

```typescript
@Throttle({ default: { limit: 3, ttl: 300000 } })  // 3 per 5 minutes
@Post('auth')
async adminLogin(@Body() dto: AdminLoginDto, @Req() req: Request) {
  const ip = req.headers['x-forwarded-for'] as string ?? req.ip
  return this.adminAuthService.login(dto.password, ip)
}
```

---

## 16. Database security

```typescript
// DATABASE_URL must include SSL:
// postgresql://user:pass@host:5432/db?sslmode=require

// In prisma/schema.prisma datasource:
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Render internal connections use SSL by default.
// Never expose PostgreSQL port 5432 publicly.
// Use Render's internal hostname for DB connections.
```

---

## 17. Referral abuse prevention

```typescript
// referrals.service.ts
async validateAndRecordReferral(
  referralCode:   string,
  newUserId:      string,
  newUserEmail:   string,
  signupIp:       string,
): Promise<void> {

  const referrer = await this.prisma.user.findUnique({
    where: { referralCode }
  })

  // Silent fail — bad code should not break signup
  if (!referrer) return

  // Cannot refer yourself — check email and ID
  if (referrer.id === newUserId) return
  if (referrer.email === newUserEmail) return

  // Check IP abuse — more than 3 signups from same IP in 24h
  const recentFromIp = await this.prisma.user.count({
    where: {
      signupIp,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }
  })

  const isSuspicious = recentFromIp > 3

  // Create referral record
  await this.prisma.referral.create({
    data: {
      referrerId:     referrer.id,
      referredUserId: newUserId,
      status:         'PENDING',
    }
  })

  if (isSuspicious) {
    await this.auditService.log({
      userId:   referrer.id,
      action:   'referral.suspicious_ip',
      entity:   'Referral',
      entityId: referrer.id,
      metadata: { signupIp, recentFromIp },
    })
  }
}
```

---

## 18. Error responses — never leak internals

```typescript
// src/common/filters/http-exception.filter.ts
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger()

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx  = host.switchToHttp()
    const res  = ctx.getResponse<Response>()
    const req  = ctx.getRequest<Request>()

    let status  = 500
    let message = 'Internal server error'

    if (exception instanceof HttpException) {
      status  = exception.getStatus()
      const body = exception.getResponse()
      message = typeof body === 'string'
        ? body
        : (body as any).message ?? 'Request failed'
    }

    // Log the real error server-side
    // Never send stack traces or DB errors to the client
    this.logger.error(
      `${req.method} ${req.url} → ${status}`,
      exception instanceof Error ? exception.stack : String(exception)
    )

    res.status(status).json({
      statusCode: status,
      message,
      timestamp:  new Date().toISOString(),
      path:       req.url,
    })
  }
}

// Register globally in main.ts:
app.useGlobalFilters(new AllExceptionsFilter())
```

---

---

# FRONTEND SECURITY

---

## 19. Token storage — memory only

```typescript
// stores/auth.store.ts
// JWT stored in Zustand (memory) only.
// Never localStorage — XSS can steal it.
// Never sessionStorage — same XSS risk.
// On page refresh the user re-authenticates via cookie or re-login.

interface AuthStore {
  token: string | null  // in memory only
  user:  User | null
  setSession:   (user: User, token: string) => void
  clearSession: () => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  token: null,
  user:  null,
  setSession:   (user, token) => set({ user, token }),
  clearSession: () => set({ user: null, token: null }),
}))
```

If you want persistent login across page refreshes without
`localStorage`, use an `HttpOnly` cookie set by NestJS on
login. HttpOnly cookies cannot be read by JavaScript —
they are invisible to XSS attacks.

```typescript
// NestJS — on successful login, set HttpOnly cookie:
res.cookie('auth_token', token, {
  httpOnly: true,
  secure:   true,           // HTTPS only
  sameSite: 'strict',
  maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
})

// NestJS — JWT strategy reads from cookie as fallback:
super({
  jwtFromRequest: ExtractJwt.fromExtractors([
    ExtractJwt.fromAuthHeaderAsBearerToken(),
    (req) => req?.cookies?.auth_token,  // fallback to cookie
  ]),
})
```

---

## 20. Admin token storage — memory only, no persistence

```typescript
// stores/admin.store.ts
interface AdminStore {
  adminToken: string | null
  setAdminToken:   (token: string) => void
  clearAdminToken: () => void
}

export const useAdminStore = create<AdminStore>((set) => ({
  adminToken: null,
  setAdminToken:   (token) => set({ adminToken: token }),
  clearAdminToken: () => set({ adminToken: null }),
}))

// Admin token is intentionally lost on page refresh.
// Admin must re-login every session.
// This is correct behaviour — admin access should not persist.
```

```typescript
// lib/api/admin-client.ts
// Separate axios instance for admin routes
// Uses adminToken from store — never ADMIN_SECRET

const adminClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
})

adminClient.interceptors.request.use((config) => {
  const token = useAdminStore.getState().adminToken
  if (!token) throw new Error('No admin token — please log in')
  config.headers.Authorization = `Bearer ${token}`
  return config
})

adminClient.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      useAdminStore.getState().clearAdminToken()
      window.location.href = '/admin/login'
    }
    return Promise.reject(err)
  }
)
```

---

## 21. Environment variables — frontend rules

```
NEXT_PUBLIC_*   → safe, bundled into browser JS, visible to anyone
                  Use for: API URL, app name, public feature flags

No prefix       → server only, never in browser
                  Use for: database URLs, secret keys, API secrets

NEVER put these in NEXT_PUBLIC_:
  ✗ NEXT_PUBLIC_ADMIN_SECRET
  ✗ NEXT_PUBLIC_JWT_SECRET
  ✗ NEXT_PUBLIC_ENCRYPTION_KEY
  ✗ NEXT_PUBLIC_DODO_API_KEY
  ✗ NEXT_PUBLIC_GOOGLE_CLIENT_SECRET
  ✗ NEXT_PUBLIC_DATABASE_URL

Safe to use as NEXT_PUBLIC_:
  ✓ NEXT_PUBLIC_API_URL
  ✓ NEXT_PUBLIC_APP_NAME
  ✓ NEXT_PUBLIC_DODO_PUBLIC_KEY (if Dodo provides one for frontend)
```

---

## 22. `useSubscriptionStore` — complete implementation

```typescript
// stores/subscription.store.ts
import { create } from 'zustand'

export type SubscriptionPlan   = 'FREE' | 'PRO'
export type SubscriptionStatus =
  | 'ACTIVE' | 'ON_HOLD' | 'CANCELLED' | 'EXPIRED'

export type ProFeature =
  | 'move_files'
  | 'duplicate_detector'
  | 'bulk_operations'
  | 'storage_alerts'
  | 'storage_history'
  | 'upload_from_url'
  | 'file_preview'
  | 'connect_account_above_limit'

interface SubscriptionData {
  plan:              SubscriptionPlan
  status:            SubscriptionStatus
  currentPeriodEnd:  string | null
  gracePeriodEndsAt: string | null
}

interface SubscriptionStore extends SubscriptionData {
  setSubscription:   (data: SubscriptionData) => void
  reset:             () => void
  isPro:             () => boolean
  isOnHold:          () => boolean
  isInGracePeriod:   () => boolean
  canAccess:         (feature: ProFeature) => boolean
}

const DEFAULT: SubscriptionData = {
  plan:              'FREE',
  status:            'ACTIVE',
  currentPeriodEnd:  null,
  gracePeriodEndsAt: null,
}

export const useSubscriptionStore = create<SubscriptionStore>(
  (set, get) => ({
    ...DEFAULT,

    setSubscription: (data) => set(data),

    reset: () => set(DEFAULT),

    isPro: () => get().plan === 'PRO',

    isOnHold: () => get().status === 'ON_HOLD',

    isInGracePeriod: () => {
      const { status, gracePeriodEndsAt } = get()
      if (status !== 'ON_HOLD' || !gracePeriodEndsAt) return false
      return new Date(gracePeriodEndsAt) > new Date()
    },

    canAccess: (feature) => {
      const { plan, status, currentPeriodEnd } = get()

      if (plan !== 'PRO') return false

      // ACTIVE — full access
      if (status === 'ACTIVE') return true

      // ON_HOLD — keep access during grace period
      if (status === 'ON_HOLD') return true

      // CANCELLED — keep access until period end
      if (status === 'CANCELLED' && currentPeriodEnd) {
        return new Date(currentPeriodEnd) > new Date()
      }

      // EXPIRED — no access
      return false
    },
  })
)
```

Populate after `GET /auth/me` resolves:

```typescript
// In auth provider or root layout useEffect:
useEffect(() => {
  if (userData?.subscription) {
    useSubscriptionStore.getState().setSubscription({
      plan:              userData.subscription.plan,
      status:            userData.subscription.status,
      currentPeriodEnd:  userData.subscription.currentPeriodEnd,
      gracePeriodEndsAt: userData.subscription.gracePeriodEndsAt,
    })
  }
}, [userData])
```

---

## 23. apiFetch / axios — no sensitive headers

```typescript
// lib/api/client.ts
const api = axios.create({
  baseURL:     process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,
})

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
  // Nothing else — no admin secrets, no encryption keys
})

api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().clearSession()
      useSubscriptionStore.getState().reset()
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)
```

---

## Pre-launch security checklist

Run through every item before going live. Do not ship
until every box is checked.

```
Startup:
  [ ] All required env vars validated on startup
  [ ] App crashes if JWT_SECRET < 32 chars
  [ ] App crashes if ENCRYPTION_KEY != 64 hex chars
  [ ] App crashes if ADMIN_SECRET < 32 chars

Encryption:
  [ ] All accessTokens encrypted before DB write
  [ ] All refreshTokens encrypted before DB write
  [ ] CryptoService decrypt throws InternalServerError on failure
  [ ] No raw tokens in any log output
  [ ] No raw tokens in any API response

Authentication:
  [ ] JWT expiry set to 7d — not infinite
  [ ] JWT algorithm set to HS256 explicitly
  [ ] JwtStrategy validates user still exists in DB
  [ ] bcrypt cost factor is exactly 12
  [ ] Rate limiting on login — 5 per minute
  [ ] Rate limiting on register — 3 per minute

OAuth:
  [ ] State parameter is random 32-byte token
  [ ] State token stored in Redis with 5 minute TTL
  [ ] State token deleted immediately after use
  [ ] Callback validates state before exchanging code

API:
  [ ] Helmet enabled with full configuration
  [ ] CORS restricted to FRONTEND_URL only
  [ ] ValidationPipe global with whitelist: true
  [ ] Every endpoint has ownership check
  [ ] Ownership failures return 403 not 404
  [ ] SSRF protection on upload-from-URL
  [ ] assertSafeUrl called before every external fetch

Webhooks:
  [ ] Raw body parser applied to /payments/webhook only
  [ ] standardwebhooks signature verification
  [ ] Timestamp within 5 minutes check
  [ ] Idempotency check using ProcessedWebhook table
  [ ] Business logic inside Prisma transaction

Admin:
  [ ] Admin login uses timing-safe comparison
  [ ] Admin JWT uses different secret from user JWT
  [ ] Admin JWT expires in 4 hours
  [ ] Admin login rate limited — 3 per 5 minutes
  [ ] Admin routes protected by AdminJwtGuard
  [ ] No ADMIN_SECRET in any frontend file
  [ ] No NEXT_PUBLIC_ADMIN_SECRET in .env

Frontend:
  [ ] User JWT in Zustand only — no localStorage
  [ ] Admin token in Zustand only — no localStorage
  [ ] No sensitive keys in NEXT_PUBLIC_ variables
  [ ] useSubscriptionStore canAccess mirrors backend logic
  [ ] apiFetch sends only Authorization header — nothing else
  [ ] Admin uses separate adminClient axios instance

Infrastructure:
  [ ] DATABASE_URL includes ?sslmode=require
  [ ] PostgreSQL port not publicly accessible
  [ ] All secrets in Render environment variables
  [ ] .env file in .gitignore
  [ ] No secrets in git history
  [ ] HTTPS enforced — no HTTP in production
  [ ] HSTS header set with 1 year maxAge
```
