# Backend build prompt — Multi-account Google Drive aggregator
# NestJS + PostgreSQL + Prisma

---

## What you are building

A production-grade NestJS REST API that lets authenticated users connect
multiple Google/Gmail accounts and manage all their Google Drive storage from
one place. Each Gmail account comes with 15 GB of free Drive storage. This app
aggregates them — showing combined quota, unified file listings, and routing
uploads to whichever account the user chooses.

The backend is responsible for:
- User authentication (JWT)
- Google OAuth 2.0 — connecting and managing multiple Google accounts per user
- Storing and auto-refreshing Google OAuth tokens (encrypted at rest)
- Fetching and caching Drive file listings across all connected accounts
- Aggregating storage quota across accounts
- Initiating Google Drive resumable upload sessions (direct upload — the
  backend never proxies file bytes)
- Cleaning up stale upload sessions

---

## Tech stack

- **Runtime**: Node.js 20+
- **Framework**: NestJS 10+
- **Language**: TypeScript (strict mode)
- **Database**: PostgreSQL 15+
- **ORM**: Prisma 5+
- **Auth**: Passport.js with JWT strategy (@nestjs/passport, passport-jwt)
- **Google API**: googleapis npm package
- **Validation**: class-validator + class-transformer
- **Config**: @nestjs/config with .env
- **Scheduling**: @nestjs/schedule (for cleanup jobs)
- **Testing**: Jest (unit), Supertest (e2e)

---

## Project structure

Generate this exact folder layout:

```
src/
  app.module.ts
  main.ts

  prisma/
    prisma.service.ts
    prisma.module.ts

  common/
    crypto/
      crypto.service.ts
      crypto.module.ts
    interceptors/
      token-refresh.interceptor.ts
    guards/
      jwt-auth.guard.ts
    decorators/
      current-user.decorator.ts
    filters/
      http-exception.filter.ts
    pipes/
      bigint-json.pipe.ts

  auth/
    auth.module.ts
    auth.controller.ts
    auth.service.ts
    strategies/
      jwt.strategy.ts
      local.strategy.ts
    dto/
      register.dto.ts
      login.dto.ts
    guards/
      local-auth.guard.ts

  google-accounts/
    google-accounts.module.ts
    google-accounts.controller.ts
    google-accounts.service.ts
    google-auth.service.ts
    dto/
      connect-account.dto.ts

  drive/
    drive.module.ts
    drive.service.ts
    quota.service.ts

  files/
    files.module.ts
    files.controller.ts
    files.service.ts
    dto/
      create-upload-session.dto.ts
      complete-upload-session.dto.ts
      list-files-query.dto.ts

  storage/
    storage.module.ts
    storage.controller.ts
    storage.service.ts

  jobs/
    jobs.module.ts
    cleanup.service.ts
```

---

## Environment variables

The app requires these in `.env`. Generate a `.env.example` with all keys
and empty values:

```
DATABASE_URL=postgresql://user:password@localhost:5432/driveapp

JWT_SECRET=
JWT_EXPIRES_IN=7d

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/google-accounts/callback

# 64-char hex string — generate with: openssl rand -hex 32
ENCRYPTION_KEY=

PORT=4000
NODE_ENV=development
```

---

## Prisma schema

Use this exact schema in `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UploadStatus {
  PENDING
  IN_PROGRESS
  COMPLETED
  FAILED
  EXPIRED
}

enum FileType {
  DOCUMENT
  SPREADSHEET
  PRESENTATION
  PDF
  IMAGE
  VIDEO
  AUDIO
  FOLDER
  OTHER
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String?
  displayName  String?
  avatarUrl    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  connectedAccounts ConnectedAccount[]
  uploadSessions    UploadSession[]

  @@index([email])
}

model ConnectedAccount {
  id          String   @id @default(cuid())
  userId      String
  googleEmail String
  displayName String?
  avatarUrl   String?

  accessToken  String
  refreshToken String
  expiresAt    DateTime

  storageLimit   BigInt   @default(16106127360)
  storageUsed    BigInt   @default(0)
  quotaUpdatedAt DateTime @default(now())

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  user           User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  fileCache      FileCache[]
  uploadSessions UploadSession[]

  @@unique([userId, googleEmail])
  @@index([userId])
  @@index([expiresAt])
}

model FileCache {
  id        String @id @default(cuid())
  accountId String

  driveFileId   String
  name          String
  mimeType      String
  fileType      FileType @default(OTHER)
  sizeBytes     BigInt   @default(0)
  webViewLink   String?
  thumbnailLink String?

  driveParentId String?
  isFolder      Boolean @default(false)

  driveCreatedAt  DateTime
  driveModifiedAt DateTime
  cachedAt        DateTime @default(now())

  account ConnectedAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@unique([accountId, driveFileId])
  @@index([accountId])
  @@index([accountId, fileType])
  @@index([accountId, driveModifiedAt(sort: Desc)])
  @@index([name])
}

model UploadSession {
  id        String @id @default(cuid())
  userId    String
  accountId String

  sessionUri String

  fileName String
  mimeType String
  fileType FileType     @default(OTHER)
  fileSize BigInt
  status   UploadStatus @default(PENDING)

  bytesUploaded BigInt    @default(0)
  expiresAt     DateTime
  completedAt   DateTime?
  createdAt     DateTime  @default(now())

  user    User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  account ConnectedAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([accountId])
  @@index([status])
  @@index([expiresAt])
}
```

---

## Module-by-module specification

---

### PrismaModule + PrismaService

- `PrismaService` extends `PrismaClient` and implements `OnModuleInit`
- Calls `this.$connect()` in `onModuleInit`
- Calls `this.$disconnect()` in `onModuleDestroy`
- Mark as `@Global()` so it doesn't need to be imported in every module
- Export `PrismaService`

---

### CryptoModule + CryptoService

Handles AES-256-GCM encryption and decryption of OAuth tokens before they
are written to the database.

**`CryptoService` must implement:**

```typescript
encrypt(plaintext: string): string
decrypt(ciphertext: string): string
```

**Implementation details:**

- Read `ENCRYPTION_KEY` from `ConfigService` — it is a 64-character hex
  string representing a 32-byte key. Convert with `Buffer.from(key, 'hex')`.
- For `encrypt`:
  - Generate a random 16-byte IV with `crypto.randomBytes(16)`
  - Use `createCipheriv('aes-256-gcm', key, iv)`
  - Get the 16-byte auth tag with `cipher.getAuthTag()`
  - Concatenate `[iv (16 bytes) | authTag (16 bytes) | ciphertext]` and
    return as a base64 string
- For `decrypt`:
  - Decode from base64
  - Slice: iv = bytes 0–15, authTag = bytes 16–31, ciphertext = bytes 32+
  - Use `createDecipheriv('aes-256-gcm', key, iv)`
  - Call `decipher.setAuthTag(authTag)` before decrypting
  - Return the decoded UTF-8 string
- Mark as `@Global()` and export `CryptoService`
- If decryption fails (wrong key, tampered data), throw a
  `InternalServerErrorException` — never leak the crypto error message

---

### AuthModule

Handles user registration, login, and JWT issuance.

**Endpoints:**

```
POST /auth/register
POST /auth/login
GET  /auth/me          (protected — requires JWT)
```

**`POST /auth/register`**

- Body: `{ email: string, password: string, displayName?: string }`
- Validate with class-validator: email must be valid, password min 8 chars
- Check if email already exists — throw `ConflictException` if so
- Hash password with `bcrypt` (salt rounds: 12)
- Create `User` in DB
- Return JWT token + user object (without passwordHash)

**`POST /auth/login`**

- Body: `{ email: string, password: string }`
- Use Passport local strategy to validate credentials
- Compare password with `bcrypt.compare`
- Throw `UnauthorizedException` if invalid
- Return JWT token + user object

**`GET /auth/me`**

- Protected by `JwtAuthGuard`
- Return the current user from DB (use `@CurrentUser()` decorator)
- Strip `passwordHash` from response

**JWT strategy:**

- Validate the payload's `sub` (userId) against the DB
- Attach the full `User` object to `request.user`
- Token payload shape: `{ sub: user.id, email: user.email }`
- Use `passReportForwardError: true`

**`@CurrentUser()` decorator:**

- A param decorator that extracts `request.user` from the execution context

---

### GoogleAccountsModule

Manages the full lifecycle of connected Google accounts — OAuth initiation,
callback handling, token storage, and disconnection.

**Endpoints:**

```
GET    /google-accounts                    (protected) list connected accounts
GET    /google-accounts/connect            (protected) redirect to Google OAuth
GET    /google-accounts/callback           (public)    OAuth callback from Google
DELETE /google-accounts/:id                (protected) disconnect an account
GET    /google-accounts/:id/quota          (protected) refresh quota for one account
```

**`GoogleAuthService`** — wraps the Google OAuth2 client:

```typescript
// Methods to implement:
getAuthUrl(userId: string): string
// Generates the Google OAuth consent URL.
// Scopes required:
//   https://www.googleapis.com/auth/drive
//   https://www.googleapis.com/auth/userinfo.email
//   https://www.googleapis.com/auth/userinfo.profile
// Pass userId in the `state` param so you can identify the user in callback.
// Set access_type: 'offline' and prompt: 'consent' to always get a refresh token.

exchangeCode(code: string): Promise<GoogleCredentials>
// Exchange the auth code for access_token, refresh_token, expiry_date.

refreshAccessToken(refreshToken: string): Promise<GoogleCredentials>
// Use the refresh token to get a new access_token.
// Returns { access_token, expiry_date }.

getUserInfo(accessToken: string): Promise<{ email: string, name: string, picture: string }>
// Call the Google userinfo endpoint to get the account's email and profile.
```

**`GoogleAccountsService`** — business logic:

```typescript
// Methods to implement:

connectAccount(userId: string, code: string): Promise<ConnectedAccount>
// 1. Call googleAuth.exchangeCode(code)
// 2. Call googleAuth.getUserInfo(access_token)
// 3. Check if this googleEmail is already connected for this userId
//    — if so, update the tokens (re-auth flow); do not create a duplicate
// 4. Encrypt accessToken and refreshToken with CryptoService before saving
// 5. Upsert the ConnectedAccount row
// 6. Return the account (decrypt tokens before returning to service layer,
//    but never expose raw tokens in HTTP responses)

listAccounts(userId: string): Promise<SafeAccount[]>
// Return all connected accounts for the user.
// SafeAccount strips accessToken, refreshToken — never expose these in responses.
// Include: id, googleEmail, displayName, avatarUrl,
//          storageLimit, storageUsed, quotaUpdatedAt, createdAt

disconnectAccount(userId: string, accountId: string): Promise<void>
// Verify the account belongs to userId — throw ForbiddenException if not.
// Delete the ConnectedAccount row (cascades to FileCache and UploadSessions).

refreshQuota(userId: string, accountId: string): Promise<ConnectedAccount>
// Fetch fresh quota from Google Drive about.get for this account.
// Update storageLimit, storageUsed, quotaUpdatedAt in DB.
// Return updated account.
```

**OAuth callback flow:**

```
GET /google-accounts/callback?code=...&state=<userId>

1. Extract userId from state param
2. Call googleAccountsService.connectAccount(userId, code)
3. Redirect to frontend: process.env.FRONTEND_URL + '/accounts?connected=true'
   On error: redirect to process.env.FRONTEND_URL + '/accounts?error=oauth_failed'
```

**Response shape for connected account (SafeAccount):**

```typescript
{
  id:             string
  googleEmail:    string
  displayName:    string | null
  avatarUrl:      string | null
  storageLimit:   string   // BigInt serialised as string
  storageUsed:    string   // BigInt serialised as string
  quotaUpdatedAt: string
  createdAt:      string
}
```

Note: BigInt must be serialised as strings in JSON. Handle this globally
(see BigInt serialisation section below).

---

### DriveModule + DriveService

A thin, reusable service that wraps the Google Drive API. It is not a
controller — it is called by FilesModule, StorageModule, and
GoogleAccountsModule. It should never be called directly from a controller.

**`DriveService` methods:**

```typescript
listFiles(accessToken: string, options?: {
  pageToken?: string
  pageSize?: number       // default 100, max 1000
  query?: string          // Drive query string e.g. "trashed=false"
}): Promise<{ files: DriveFile[], nextPageToken?: string }>

getQuota(accessToken: string): Promise<{
  limit: bigint
  usage: bigint
  usageInDrive: bigint
}>

createResumableUploadSession(accessToken: string, metadata: {
  name: string
  mimeType: string
  fileSize: number
  parentId?: string
}): Promise<string>
// Returns the session URI from the Location response header.

deleteFile(accessToken: string, fileId: string): Promise<void>

getFile(accessToken: string, fileId: string): Promise<DriveFile>
```

**Implementation details for `DriveService`:**

- Use the `googleapis` package: `import { google } from 'googleapis'`
- For each method, build an OAuth2 client, set credentials with the
  access token, then call the Drive API.
- For `createResumableUploadSession`: make a raw `fetch` call to
  `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`
  with the required headers. Return the `Location` response header value.
- Handle Google API errors: catch `GaxiosError`, map status codes to
  appropriate NestJS exceptions:
  - 401 → `UnauthorizedException` (token truly invalid)
  - 403 → `ForbiddenException`
  - 404 → `NotFoundException`
  - 429 → `HttpException` with status 429 and message 'Drive API rate limit'
  - 5xx → `ServiceUnavailableException`

**`QuotaService`** (inside DriveModule):

```typescript
getAggregatedQuota(userId: string): Promise<{
  totalLimit:    bigint
  totalUsed:     bigint
  totalFree:     bigint
  perAccount: Array<{
    accountId:   string
    googleEmail: string
    limit:       bigint
    used:        bigint
    free:        bigint
  }>
}>
```

- Fetch all ConnectedAccounts for userId
- Decrypt each accessToken with CryptoService
- Call `driveService.getQuota` for all accounts in parallel with `Promise.all`
- If one account fails (expired token, revoked access), log the error and
  return `{ limit: 0n, used: 0n, usageInDrive: 0n }` for that account —
  never let one bad account break the whole response
- Update `storageLimit`, `storageUsed`, `quotaUpdatedAt` in DB for each
  account after fetching
- Return the aggregated result

---

### FilesModule

The aggregation layer. Fans out Drive API calls across all connected accounts,
merges results, and manages the file cache.

**Endpoints:**

```
GET    /files                       (protected) list all files across accounts
POST   /files/upload-session        (protected) create resumable upload session
PATCH  /files/upload-session/:id    (protected) mark upload complete
DELETE /files/:accountId/:fileId    (protected) delete a file from a specific account
```

**`GET /files` query parameters:**

```typescript
// ListFilesQueryDto
accountId?: string      // filter to one account
fileType?:  FileType    // filter by type
search?:    string      // search by filename (case-insensitive)
sortBy?:    'name' | 'size' | 'modifiedAt'   // default: modifiedAt
sortOrder?: 'asc' | 'desc'                   // default: desc
page?:      number      // default: 1
limit?:     number      // default: 50, max: 200
```

**`FilesService` methods:**

```typescript
listFiles(userId: string, query: ListFilesQueryDto): Promise<PaginatedFiles>
// 1. Get all ConnectedAccounts for the user (filter by accountId if provided)
// 2. Check cache freshness: if ANY account has cachedAt older than 5 minutes,
//    re-fetch from Drive for that account and update FileCache
// 3. For re-fetching: decrypt token, call driveService.listFiles, upsert
//    FileCache rows. Handle pagination — fetch all pages if pageSize < total.
// 4. Query FileCache with filters, sorting, and pagination
// 5. Return paginated result with account metadata joined

createUploadSession(userId: string, dto: CreateUploadSessionDto): Promise<UploadSession>
// CreateUploadSessionDto: { accountId, fileName, mimeType, fileSize }
// 1. Verify accountId belongs to userId — ForbiddenException if not
// 2. Decrypt the account's accessToken
// 3. Call driveService.createResumableUploadSession
// 4. Persist UploadSession to DB with:
//    status: PENDING
//    expiresAt: now + 7 days (Google's resumable session lifetime)
// 5. Return the UploadSession including sessionUri
//    (sessionUri is safe to return to the owning user — it's their own account)

completeUpload(userId: string, sessionId: string, dto: CompleteUploadDto): Promise<void>
// CompleteUploadDto: { driveFileId: string, bytesUploaded: bigint }
// 1. Find UploadSession, verify it belongs to userId
// 2. Update status to COMPLETED, set completedAt, set bytesUploaded
// 3. Immediately invalidate the FileCache for that account (set cachedAt to epoch)
//    so the next listFiles call re-fetches and includes the new file

deleteFile(userId: string, accountId: string, fileId: string): Promise<void>
// 1. Verify accountId belongs to userId
// 2. Decrypt token
// 3. Call driveService.deleteFile — confirm with Drive first, never trust cache
// 4. Delete the matching FileCache row if it exists
```

**File type inference:**

Implement a helper `inferFileType(mimeType: string): FileType` that maps
Google MIME types to your `FileType` enum:

```
application/vnd.google-apps.document      → DOCUMENT
application/vnd.google-apps.spreadsheet   → SPREADSHEET
application/vnd.google-apps.presentation  → PRESENTATION
application/pdf                           → PDF
image/*                                   → IMAGE
video/*                                   → VIDEO
audio/*                                   → AUDIO
application/vnd.google-apps.folder        → FOLDER
everything else                           → OTHER
```

**Cache invalidation strategy:**

- Cache TTL: 5 minutes
- On `listFiles`: check `cachedAt` for each account. If stale, re-fetch.
- On `completeUpload` or `deleteFile`: immediately set `cachedAt = new Date(0)`
  to force re-fetch on next list call.
- Never serve cached data for delete operations. Always confirm deletions
  with Drive directly.

**Paginated response shape:**

```typescript
{
  data: FileRecord[]
  meta: {
    total:    number
    page:     number
    limit:    number
    lastPage: number
  }
}

// FileRecord shape:
{
  id:             string   // FileCache.id
  driveFileId:    string
  name:           string
  fileType:       FileType
  mimeType:       string
  sizeBytes:      string   // BigInt as string
  webViewLink:    string | null
  thumbnailLink:  string | null
  isFolder:       boolean
  driveModifiedAt: string
  account: {
    id:          string
    googleEmail: string
    displayName: string | null
    avatarUrl:   string | null
  }
}
```

---

### StorageModule

Aggregates quota across all connected accounts. Thin controller over
`QuotaService` from DriveModule.

**Endpoints:**

```
GET /storage/summary    (protected) aggregated quota across all accounts
```

**Response shape:**

```typescript
{
  totalLimit:  string   // BigInt as string, bytes
  totalUsed:   string
  totalFree:   string
  accounts: Array<{
    accountId:   string
    googleEmail: string
    limit:       string
    used:        string
    free:        string
  }>
}
```

**Caching:** Return cached quota from `ConnectedAccount.storageUsed` /
`storageLimit` if `quotaUpdatedAt` is within the last 10 minutes. Otherwise
call `QuotaService.getAggregatedQuota` which hits Drive and updates the cache.
This prevents hammering Google's API on every dashboard load.

---

### TokenRefreshInterceptor (global)

A `NestInterceptor` registered globally in `AppModule` via `APP_INTERCEPTOR`.

**Full implementation:**

```typescript
@Injectable()
export class TokenRefreshInterceptor implements NestInterceptor {
  constructor(
    private prisma: PrismaService,
    private googleAuth: GoogleAuthService,
    private crypto: CryptoService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const req  = context.switchToHttp().getRequest()
    const user = req.user
    if (!user) return next.handle()

    const accounts = await this.prisma.connectedAccount.findMany({
      where: { userId: user.id },
    })

    await Promise.all(
      accounts
        .filter(a => this.isExpiringSoon(a.expiresAt))
        .map(a  => this.refresh(a))
    )

    return next.handle()
  }

  private isExpiringSoon(expiresAt: Date): boolean {
    const BUFFER_MS = 5 * 60 * 1000
    return new Date(expiresAt).getTime() - BUFFER_MS < Date.now()
  }

  private async refresh(account: ConnectedAccount): Promise<void> {
    try {
      const plainRefreshToken = this.crypto.decrypt(account.refreshToken)
      const creds = await this.googleAuth.refreshAccessToken(plainRefreshToken)

      await this.prisma.connectedAccount.update({
        where: { id: account.id },
        data:  {
          accessToken: this.crypto.encrypt(creds.access_token!),
          expiresAt:   new Date(creds.expiry_date!),
        },
      })
    } catch (err) {
      // Log but do not throw — a failed refresh on one account
      // must not block the request for the other accounts
      console.error(`Token refresh failed for account ${account.id}:`, err)
    }
  }
}
```

**Important:** The interceptor runs AFTER the JWT guard sets `req.user`.
It runs BEFORE the controller handler executes. This order is guaranteed
because NestJS applies guards before interceptors in the request lifecycle.

---

### JobsModule — CleanupService

A scheduled service using `@nestjs/schedule`.

**Jobs to implement:**

```typescript
@Cron('0 * * * *')   // every hour
async expireUploadSessions() {
  // Mark UploadSession rows as EXPIRED where:
  //   status IN (PENDING, IN_PROGRESS)
  //   AND expiresAt < now()
  await this.prisma.uploadSession.updateMany({
    where: {
      status:    { in: ['PENDING', 'IN_PROGRESS'] },
      expiresAt: { lt: new Date() },
    },
    data: { status: 'EXPIRED' },
  })
}

@Cron('0 2 * * *')   // daily at 2am
async pruneOldFileCacheEntries() {
  // Delete FileCache rows where cachedAt is older than 24 hours
  // AND there is no longer a ConnectedAccount with that accountId
  // (handles accounts that were disconnected mid-session)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  await this.prisma.fileCache.deleteMany({
    where: { cachedAt: { lt: cutoff } },
  })
}
```

---

## BigInt JSON serialisation

Prisma returns `BigInt` values for `sizeBytes`, `storageLimit`, `storageUsed`,
`fileSize`, `bytesUploaded`. JSON.stringify does not handle BigInt natively
and will throw `TypeError: Do not know how to serialize a BigInt`.

**Fix — apply globally in `main.ts`:**

```typescript
// Patch BigInt serialisation before bootstrap
(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}
```

This converts all BigInt values to strings in JSON responses automatically.
Document this in the codebase so future developers know why it's there.

---

## Global exception filter

Implement an `HttpExceptionFilter` that catches all exceptions and returns
a consistent error shape:

```typescript
{
  statusCode: number
  message:    string | string[]
  error:      string
  timestamp:  string
  path:       string
}
```

Register it globally in `main.ts` with `app.useGlobalFilters(...)`.

---

## Validation pipe

Register a global `ValidationPipe` in `main.ts`:

```typescript
app.useGlobalPipes(new ValidationPipe({
  whitelist:        true,    // strip unknown properties
  forbidNonWhitelisted: true,
  transform:        true,    // auto-transform payloads to DTO instances
  transformOptions: { enableImplicitConversion: true },
}))
```

---

## CORS

Enable CORS in `main.ts`:

```typescript
app.enableCors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:3001',
  credentials: true,
})
```

---

## AppModule wiring

Register everything in the correct order:

```typescript
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    AuthModule,
    GoogleAccountsModule,
    DriveModule,
    FilesModule,
    StorageModule,
    JobsModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: TokenRefreshInterceptor },
    { provide: APP_FILTER,      useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
```

---

## Security requirements

1. **Token encryption**: Never write a raw OAuth token to the database.
   All `accessToken` and `refreshToken` fields pass through `CryptoService`
   before any Prisma write. Decrypt immediately before use.

2. **Ownership checks**: Every endpoint that touches a `ConnectedAccount`
   or `UploadSession` must verify `userId` matches before proceeding.
   Throw `ForbiddenException` — not `NotFoundException` — on mismatch.
   (Returning 404 leaks the existence of the resource.)

3. **Session URI confidentiality**: `UploadSession.sessionUri` must never
   appear in list endpoints. Only return it in the `POST /files/upload-session`
   response and the `GET /files/upload-session/:id` response (owner only).

4. **JWT secret**: Must be at least 32 characters. Validate on startup:

   ```typescript
   // In main.ts, before app.listen:
   const jwtSecret = configService.get<string>('JWT_SECRET')
   if (!jwtSecret || jwtSecret.length < 32) {
     throw new Error('JWT_SECRET must be at least 32 characters')
   }
   ```

5. **Helmet**: Install and enable `helmet` in `main.ts`:
   `app.use(require('helmet')())`

---

## Error handling conventions

- `400 BadRequest` — invalid input (class-validator catches these)
- `401 Unauthorized` — missing or invalid JWT
- `403 Forbidden` — valid JWT but accessing another user's resource
- `404 NotFound` — resource does not exist
- `409 Conflict` — duplicate resource (e.g. same Google account connected twice)
- `429 TooManyRequests` — Google Drive rate limit hit
- `503 ServiceUnavailable` — Google Drive API unreachable

Never expose raw error messages from googleapis or Prisma to the client.
Log the real error server-side, return a sanitised message.

---

## Key architectural decisions already made

1. **Direct resumable upload** — the NestJS server never proxies file bytes.
   It only creates the upload session URI and returns it to the client.
   The client uploads directly to Google. This eliminates server bandwidth
   costs and supports upload resumption on unstable connections (important
   for mobile users in emerging markets).

2. **Token refresh via global interceptor** — tokens are refreshed
   automatically before every request, not inside individual service methods.
   This keeps service methods clean and ensures no Drive API call ever
   fails due to an expired token.

3. **FileCache as a read cache, not source of truth** — always confirm
   deletes with Google Drive directly. Invalidate cache immediately on
   mutations. Re-fetch from Drive when TTL (5 minutes) is exceeded.

4. **Quota cached on ConnectedAccount** — avoid calling `about.get` on
   every dashboard load. Serve cached values if within 10-minute TTL.

5. **BigInt for all byte values** — file sizes and storage quotas exceed
   JavaScript's safe integer range for large accounts. Use BigInt throughout
   and serialise as strings in JSON responses.

6. **Ownership over existence in 403 vs 404** — always return 403 on
   ownership mismatch. Returning 404 leaks information about what exists.

---

## What to generate

1. All files in the folder structure above, fully implemented
2. `prisma/schema.prisma` as specified
3. `.env.example` with all required keys
4. `package.json` with all required dependencies
5. A `README.md` with:
   - Setup instructions
   - How to generate the ENCRYPTION_KEY
   - How to run migrations
   - All API endpoints listed with method, path, auth requirement, and
     request/response shape
