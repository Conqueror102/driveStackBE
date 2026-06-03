# Gmail Aggregator Backend System Documentation

## 1. Purpose

This backend is a NestJS REST API that lets one authenticated app user connect multiple Google accounts and manage Google Drive storage across those accounts from a single API.

The system handles:

- User registration and login with JWT authentication
- Google OAuth 2.0 account connection
- Encrypted storage of Google access and refresh tokens
- Automatic Google access token refresh before protected requests
- Google Drive file listing and local cache management
- Aggregated storage quota across all connected Google accounts
- Google Drive resumable upload session creation
- Upload session completion tracking
- Google Drive file deletion
- Scheduled cleanup for expired upload sessions and stale cache rows
- One-time OAuth state validation to prevent account-linking CSRF
- Account health states for revoked tokens and sync failures
- Audit logging for sensitive user/account/file actions
- Redis-backed request rate limiting with in-memory fallback
- Redis/BullMQ workers for file sync, quota refresh, token refresh retry, and upload verification
- Separate admin authentication and admin APIs for system metrics, user management, and audit review
- Request/visit tracking for backend traffic analytics
- Swagger/OpenAPI docs at `/docs/api`

The backend does not proxy uploaded file bytes. It only creates Google Drive resumable upload session URIs, then the client uploads directly to Google.

## 2. Technology Stack

- Runtime: Node.js
- Framework: NestJS
- Language: TypeScript with strict mode
- Database: PostgreSQL
- ORM: Prisma
- Auth: Passport.js, JWT, Local strategy
- Google APIs: `googleapis`
- Validation: `class-validator`, `class-transformer`
- Config: `@nestjs/config`
- Scheduling: `@nestjs/schedule`
- Security middleware: `helmet`
- Password hashing: `bcrypt`

## 3. High-Level Architecture

```text
Client / Postman
  |
  | HTTP REST requests
  v
NestJS Controllers
  |
  | Validate DTOs, read current JWT user
  v
Application Services
  |
  | Business rules, ownership checks, token encryption/decryption
  v
PrismaService
  |
  v
PostgreSQL

Application Services
  |
  | Google OAuth / Drive API calls
  v
Google APIs
```

The app is module-based. Controllers expose HTTP endpoints. Services own business logic. Prisma owns persistence. Google services wrap external Google APIs. Common infrastructure handles authentication, crypto, request validation, token refresh, and error formatting.

## 4. Request Lifecycle

For protected endpoints:

1. Client sends `Authorization: Bearer <jwt>`.
2. `JwtAuthGuard` validates the token using `JwtStrategy`.
3. `JwtStrategy` loads the user from the database and attaches it to `request.user`.
4. `TokenRefreshInterceptor` runs after the guard and before the controller handler.
5. The interceptor checks all connected Google accounts for the user.
6. If an account access token expires within 5 minutes, it refreshes that token using the encrypted refresh token.
7. Controller receives the request.
8. DTO validation runs through the global `ValidationPipe`.
9. Service performs business logic and ownership checks.
10. Prisma reads/writes PostgreSQL.
11. Response is serialized. BigInt values are globally converted to strings.
12. Errors are formatted by the global `HttpExceptionFilter`.

Global `RateLimitGuard` runs before route handlers and limits requests by IP, HTTP method, and route. Auth routes have a lower limit than normal read endpoints. If `REDIS_URL` is configured, limits are stored in Redis so they work across API instances. Without Redis, the guard falls back to in-memory buckets.

## 5. Folder Structure

```text
src/
  app.module.ts
  main.ts

  prisma/
    prisma.module.ts
    prisma.service.ts

  common/
    crypto/
      crypto.module.ts
      crypto.service.ts
    decorators/
      current-user.decorator.ts
    filters/
      http-exception.filter.ts
    guards/
      jwt-auth.guard.ts
      rate-limit.guard.ts
    interceptors/
      request-logging.interceptor.ts
      token-refresh.interceptor.ts
    pipes/
      bigint-json.pipe.ts
    audit/
      audit.module.ts
      audit.service.ts

  auth/
    auth.module.ts
    auth.controller.ts
    auth.service.ts
    dto/
      login.dto.ts
      register.dto.ts
    guards/
      local-auth.guard.ts
    strategies/
      jwt.strategy.ts
      local.strategy.ts

  admin/
    admin.module.ts
    admin.controller.ts
    admin.service.ts
    admin-auth.controller.ts
    admin-auth.service.ts
    current-admin.decorator.ts
    dto/
      admin-login.dto.ts
      list-admin-users-query.dto.ts
      update-user-status.dto.ts
    guards/
      admin-jwt-auth.guard.ts
    strategies/
      admin-jwt.strategy.ts
    scripts/
      create-admin.ts

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
      complete-upload-session.dto.ts
      create-upload-session.dto.ts
      list-files-query.dto.ts

  storage/
    storage.module.ts
    storage.controller.ts
    storage.service.ts

  jobs/
    jobs.module.ts
    cleanup.service.ts

  email/
    email.module.ts
    email.service.ts
    email.types.ts
    providers/
      console.provider.ts
      custom-http.provider.ts
      resend.provider.ts
      sendgrid.provider.ts
      zoho.provider.ts

  redis/
    redis.module.ts
    redis.service.ts

  queue/
    queue.module.ts
    queue.service.ts

prisma/
  schema.prisma

docs/
  SYSTEM_DOCUMENTATION.md
  Gmail-Aggregator.postman_collection.json
  Gmail-Aggregator.postman_environment.json
```

## 6. Module Responsibilities

### AppModule

File: `src/app.module.ts`

The root module imports every feature module and registers global providers:

- `ConfigModule.forRoot({ isGlobal: true })`
- `ScheduleModule.forRoot()`
- `PrismaModule`
- `CryptoModule`
- `AuthModule`
- `AdminModule`
- `GoogleAccountsModule`
- `DriveModule`
- `FilesModule`
- `StorageModule`
- `JobsModule`
- Global `TokenRefreshInterceptor`
- Global `RequestLoggingInterceptor`
- Global `HttpExceptionFilter`

### Main Bootstrap

File: `src/main.ts`

Responsible for application startup:

- Patches `BigInt.prototype.toJSON` so Prisma BigInt fields return as strings.
- Validates `JWT_SECRET` is at least 32 characters.
- Enables `helmet`.
- Enables CORS using `FRONTEND_URL` or `http://localhost:3001`.
- Registers global validation with whitelist and transform enabled.
- Starts the app on `PORT` or `4000`.

### Common Guards And Audit

Files:

- `src/common/guards/rate-limit.guard.ts`
- `src/common/audit/audit.service.ts`

`RateLimitGuard` provides Redis-backed rate limiting with in-memory fallback:

- Auth routes: 20 requests per minute per IP/method/route
- Mutation routes: 60 requests per minute per IP/method/route
- Other routes: 120 requests per minute per IP/method/route

For multi-instance production deployment, keep `REDIS_URL` configured so limits are shared across API instances.

`AuditService` writes security-sensitive events to `AuditLog`, including login, logout, Google account connection, account disconnect, quota refresh, file sync, upload completion, and file deletion.

`RequestLoggingInterceptor` writes lightweight request analytics to `RequestLog`. It records method, path, status code, duration, timestamp, optional user/admin ID, a hashed IP address, and user agent. The hash uses `REQUEST_LOG_SALT` when configured, otherwise `JWT_SECRET`.

### EmailModule

Files:

- `src/email/email.module.ts`
- `src/email/email.service.ts`
- `src/email/email.types.ts`
- `src/email/providers/*`

`EmailService` is provider-based. Auth code calls one stable service, and `.env` decides which adapter sends the email.

Supported providers:

- `console`: logs email content locally
- `sendgrid`: SendGrid HTTP API
- `resend`: Resend HTTP API
- `zoho`: Zoho/ZeptoMail HTTP API
- `custom_http`: any HTTP mail service that accepts the generic JSON payload

To add another provider later, create one adapter implementing `EmailProvider` and register it in `EmailService.createProvider()`. No auth code changes are required.

### RedisModule And QueueModule

Files:

- `src/redis/redis.module.ts`
- `src/redis/redis.service.ts`
- `src/queue/queue.module.ts`
- `src/queue/queue.service.ts`

`RedisService` owns the shared Redis connection. It is used by:

- Rate limiting
- BullMQ queue producers
- BullMQ workers

`QueueService` owns these queues:

- `file-sync`: background Drive file sync
- `quota-refresh`: background quota refresh
- `token-refresh`: retry Google token refresh after interceptor failure
- `upload-verify`: background upload completion verification

If `REDIS_URL` is missing, queues are disabled and critical operations fall back to inline execution where possible.

### PrismaModule

Files:

- `src/prisma/prisma.module.ts`
- `src/prisma/prisma.service.ts`

`PrismaService` extends `PrismaClient`.

It connects when the Nest module initializes and disconnects when the module is destroyed.

The module is global, so other services can inject `PrismaService` without importing the module repeatedly.

### CryptoModule

Files:

- `src/common/crypto/crypto.module.ts`
- `src/common/crypto/crypto.service.ts`

Encrypts and decrypts Google OAuth tokens using AES-256-GCM.

Encryption output format:

```text
base64(iv | authTag | ciphertext)
```

The encryption key comes from `ENCRYPTION_KEY`, which must be a 64-character hex string.

Important rule: raw Google tokens should never be written to the database. Tokens must pass through `CryptoService.encrypt()` first.

### AuthModule

Files:

- `src/auth/auth.module.ts`
- `src/auth/auth.controller.ts`
- `src/auth/auth.service.ts`
- `src/auth/strategies/jwt.strategy.ts`
- `src/auth/strategies/local.strategy.ts`

Handles:

- User registration
- Login
- JWT issuance
- Current user lookup

Endpoints:

- `POST /auth/register`
- `POST /auth/login`
- `GET /auth/me`
- `POST /auth/logout`
- `POST /auth/email/request-verification`
- `POST /auth/email/verify`
- `POST /auth/password/request-reset`
- `POST /auth/password/reset`
- `POST /auth/password/change`

Register flow:

1. Validate email and password.
2. Check if email already exists.
3. Hash password with bcrypt.
4. Create user.
5. Return JWT and safe user object.

Login flow:

1. Local strategy receives email and password.
2. Password is compared with bcrypt.
3. If valid, return JWT and safe user object.

JWT payload:

```json
{
  "sub": "user-id",
  "email": "user@example.com",
  "tokenVersion": 0
}
```

`POST /auth/logout` increments `User.tokenVersion`. Existing JWTs with an old version become invalid.

### AdminModule

Files:

- `src/admin/admin.module.ts`
- `src/admin/admin-auth.controller.ts`
- `src/admin/admin-auth.service.ts`
- `src/admin/admin.controller.ts`
- `src/admin/admin.service.ts`
- `src/admin/strategies/admin-jwt.strategy.ts`
- `src/admin/scripts/create-admin.ts`

Handles the private admin side of the system. Admins are stored in a separate `Admin` table, not mixed into normal app users.

Bootstrap or update the first admin:

```bash
npm run admin:create
```

The script reads:

```env
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_DISPLAY_NAME=
```

Admin endpoints:

- `POST /admin/auth/login`
- `GET /admin/auth/me`
- `POST /admin/auth/logout`
- `GET /admin/metrics/summary`
- `GET /admin/users`
- `GET /admin/users/:id`
- `PATCH /admin/users/:id/status`
- `GET /admin/audit-logs`

Admin JWTs are separate from user JWTs and include the admin token version. `POST /admin/auth/logout` increments `Admin.tokenVersion`, invalidating older admin JWTs.

User management is intentionally non-destructive. Admins can disable and enable users, but this API does not hard-delete users or their connected Drive metadata. Disabling a user sets `User.status = DISABLED` and increments `User.tokenVersion`, so existing user JWTs stop working immediately.

Metrics currently cover:

- Total users
- Active and disabled users
- Connected Google accounts
- Cached Drive files
- Upload sessions
- Total recorded requests/visits
- Recent request volume

### GoogleAccountsModule

Files:

- `src/google-accounts/google-accounts.module.ts`
- `src/google-accounts/google-accounts.controller.ts`
- `src/google-accounts/google-accounts.service.ts`
- `src/google-accounts/google-auth.service.ts`

Handles Google OAuth account connection and account management.

Endpoints:

- `GET /google-accounts`
- `GET /google-accounts/connect`
- `GET /google-accounts/callback`
- `DELETE /google-accounts/:id`
- `GET /google-accounts/:id/quota`

OAuth connection flow:

1. User calls `GET /google-accounts/connect`.
2. Backend creates a random one-time OAuth state.
3. Backend stores only the SHA-256 hash of that state in `OAuthState`.
4. Backend returns a redirect to Google OAuth with the raw state.
5. Google redirects back to `/google-accounts/callback?code=...&state=<state>`.
6. Backend hashes and consumes the state. Used or expired states are rejected.
7. Backend exchanges the code for Google tokens.
8. Backend fetches Google profile email/name/avatar.
9. Backend encrypts tokens.
10. Backend upserts `ConnectedAccount`.
11. Backend redirects to the frontend.

If the same Google email is connected again by the same user, the account is updated instead of duplicated. If another app user tries to connect a Google account already connected elsewhere, the API returns `409 Conflict`.

On disconnect, the backend attempts to revoke the Google refresh token before deleting the connected account.

### DriveModule

Files:

- `src/drive/drive.module.ts`
- `src/drive/drive.service.ts`
- `src/drive/quota.service.ts`

`DriveService` wraps Google Drive API calls:

- List files
- Get quota
- Create resumable upload session
- Delete file
- Get file

`QuotaService` aggregates quota across all connected accounts for a user.

If one connected account fails during quota aggregation, it logs the error and returns zero quota for that account instead of failing the whole request.

### FilesModule

Files:

- `src/files/files.module.ts`
- `src/files/files.controller.ts`
- `src/files/files.service.ts`

Handles unified file listing, upload sessions, upload completion, and file deletion.

Endpoints:

- `GET /files`
- `POST /files/upload-session`
- `GET /files/upload-session/:id`
- `PATCH /files/upload-session/:id`
- `DELETE /files/:accountId/:fileId`

File listing behavior:

1. Load connected accounts for the user.
2. If cache is stale for any account, enqueue file sync in Redis/BullMQ.
3. If Redis is not configured, sync inline as fallback.
4. First sync uses paginated Drive `files.list` and stores a Drive changes page token.
5. Later syncs use Drive `changes.list` to apply only changed/removed files.
6. If Google says the changes token expired, the system falls back to a full sync.
7. Worker tracks sync progress in `SyncJob`.
8. API queries `FileCache` with filters, search, parent folder filtering, sorting, and pagination.
9. API returns unified paginated results with account metadata.

Cache TTL:

```text
5 minutes
```

Upload session behavior:

1. Verify account ownership.
2. Decrypt Google access token.
3. Ask Google Drive for a resumable upload URI.
4. Store upload session in the database.
5. Return the session URI to the owning user.

The backend never uploads the file bytes.

Upload completion behavior:

1. Verify upload session ownership.
2. Fetch the uploaded file from Google Drive using the owning account.
3. Compare Drive file metadata with the upload session.
4. Mark the session `COMPLETED` only if verification succeeds.
5. Mark the session `FAILED` if metadata does not match.
6. Upsert the uploaded file into `FileCache`.

With Redis configured, upload verification runs in the `upload-verify` queue. Without Redis, the API verifies inline.

### StorageModule

Files:

- `src/storage/storage.module.ts`
- `src/storage/storage.controller.ts`
- `src/storage/storage.service.ts`

Endpoint:

- `GET /storage/summary`

Returns total storage limit, total used, total free, and per-account quota.

Quota cache TTL:

```text
10 minutes
```

If all quota rows are fresh, values come from `ConnectedAccount`. Otherwise, `QuotaService` refreshes them from Google Drive.

### JobsModule

Files:

- `src/jobs/jobs.module.ts`
- `src/jobs/cleanup.service.ts`

Scheduled jobs:

- Every hour: marks expired pending/in-progress upload sessions as `EXPIRED`.
- Daily at 2 AM: deletes old file cache rows with `cachedAt` older than 24 hours.

## 7. Database Design

### User

Stores local app users.

Important fields:

- `id`
- `email`
- `passwordHash`
- `displayName`
- `avatarUrl`
- `status`
- `tokenVersion`

Relations:

- One user has many connected Google accounts.
- One user has many upload sessions.
- One user has many request logs.

`status` controls whether the user can authenticate and keep using existing JWTs. Disabled users cannot log in, and existing JWTs fail validation.

### Admin

Stores private admin identities.

Important fields:

- `id`
- `email`
- `passwordHash`
- `displayName`
- `role`
- `tokenVersion`
- `lastLoginAt`

Admin records are created with `npm run admin:create`. Admins authenticate through `/admin/auth/login`, not `/auth/login`.

### ConnectedAccount

Stores each Google account connected by a user.

Important fields:

- `userId`
- `googleEmail`
- `displayName`
- `avatarUrl`
- `accessToken`
- `refreshToken`
- `expiresAt`
- `storageLimit`
- `storageUsed`
- `quotaUpdatedAt`
- `status`
- `lastSyncAt`
- `lastSyncError`
- `reauthRequiredAt`
- `driveChangesPageToken`

Security:

- `accessToken` and `refreshToken` are encrypted.
- `googleEmail` is globally unique, so one Google account can only be connected to one app user.

Account statuses:

- `ACTIVE`: account is usable
- `REAUTH_REQUIRED`: Google token refresh failed or access was revoked
- `SYNC_FAILED`: Drive or quota sync failed
- `DISCONNECTED`: reserved status for historical/audit flows

### FileCache

Stores cached Google Drive file metadata.

Important fields:

- `accountId`
- `driveFileId`
- `name`
- `mimeType`
- `fileType`
- `sizeBytes`
- `webViewLink`
- `thumbnailLink`
- `driveParentId`
- `isFolder`
- `driveCreatedAt`
- `driveModifiedAt`
- `cachedAt`

Cache is not the source of truth. Deletions always go to Google Drive first.

### UploadSession

Stores Google Drive resumable upload sessions.

Important fields:

- `userId`
- `accountId`
- `sessionUri`
- `fileName`
- `mimeType`
- `fileType`
- `fileSize`
- `status`
- `bytesUploaded`
- `driveFileId`
- `verifiedAt`
- `expiresAt`
- `completedAt`

`sessionUri` is confidential and should only be returned to the owning user for a specific upload session.

### AuthToken

Stores hashed one-time tokens for email verification and password reset.

Important fields:

- `userId`
- `type`
- `tokenHash`
- `expiresAt`
- `usedAt`

### OAuthState

Stores one-time OAuth state hashes.

Important fields:

- `userId`
- `stateHash`
- `expiresAt`
- `usedAt`

Raw OAuth state values are not stored in the database.

### SyncJob

Tracks Drive file sync runs.

Important fields:

- `userId`
- `accountId`
- `status`
- `error`
- `startedAt`
- `finishedAt`

### AuditLog

Stores security-sensitive activity.

Important fields:

- `userId`
- `adminId`
- `action`
- `accountId`
- `resourceId`
- `metadata`
- `ipAddress`
- `userAgent`
- `createdAt`

Admin login/logout and user enable/disable actions are also written here.

### RequestLog

Stores backend request/visit analytics for admin reporting.

Important fields:

- `userId`
- `adminId`
- `method`
- `path`
- `statusCode`
- `durationMs`
- `ipHash`
- `userAgent`
- `createdAt`

The raw IP address is not stored. `ipHash` is enough for coarse abuse/visit analysis without keeping plain IP data.

## 8. Security Model

### JWT Authentication

Protected endpoints use `JwtAuthGuard`.

The JWT `sub` field contains the app user ID. The strategy loads the full user from the database and attaches it to the request.

JWTs include `tokenVersion`. Logout increments the database version and invalidates older tokens.

### Ownership Checks

Any endpoint touching `ConnectedAccount` or `UploadSession` validates ownership.

If a resource exists but belongs to another user, the API returns `403 Forbidden`.

### Token Encryption

Google tokens are encrypted at rest with AES-256-GCM.

Only decrypted immediately before calling Google APIs.

### OAuth State Protection

OAuth state is random, one-time use, expires after 10 minutes, and is stored as a SHA-256 hash. This prevents using a raw `userId` as OAuth state and reduces account-linking CSRF risk.

### Rate Limiting

The API includes Redis-backed rate limiting. If Redis is unavailable or not configured, it falls back to process memory for local development.

### Upload Session URI Confidentiality

Upload session URIs are only returned by:

- `POST /files/upload-session`
- `GET /files/upload-session/:id`

They are not included in list endpoints.

### Error Sanitization

Google and Prisma internals should not be exposed to clients. Errors are logged server-side and returned in a consistent shape.

## 9. Error Shape

All errors use:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request",
  "timestamp": "2026-05-28T00:00:00.000Z",
  "path": "/files"
}
```

## 10. Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/driveapp

JWT_SECRET=
JWT_EXPIRES_IN=7d

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/google-accounts/callback

ENCRYPTION_KEY=

FRONTEND_URL=http://localhost:3001
REDIS_URL=redis://localhost:6379

ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_DISPLAY_NAME=
REQUEST_LOG_SALT=

EMAIL_PROVIDER=console
EMAIL_FROM=no-reply@example.com
SENDGRID_API_KEY=
RESEND_API_KEY=
ZOHO_API_KEY=
ZOHO_API_URL=https://api.zeptomail.com/v1.1/email
EMAIL_HTTP_URL=
EMAIL_HTTP_AUTH_HEADER=
EMAIL_HTTP_PROVIDER_NAME=custom_http

PORT=4000
NODE_ENV=development
```

Generate `ENCRYPTION_KEY`:

```bash
openssl rand -hex 32
```

`JWT_SECRET` must be at least 32 characters.

## 11. Setup Flow

1. Install dependencies:

```bash
npm install
```

On Windows PowerShell, if `npm` is blocked by execution policy, use:

```bash
npm.cmd install
```

2. Copy `.env.example` to `.env`.

3. Fill in:

- `DATABASE_URL`
- `JWT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `ENCRYPTION_KEY`
- `FRONTEND_URL`
- `REDIS_URL`
- Email provider variables for production email delivery

4. Generate Prisma client:

```bash
npm run prisma:generate
```

5. Run migrations:

```bash
npm run prisma:migrate
```

6. Start the app:

```bash
npm run start:dev
```

## 12. API Endpoint Summary

| Method | Path | Auth | Purpose |
|---|---|---:|---|
| POST | `/auth/register` | No | Create app user |
| POST | `/auth/login` | No | Login and get JWT |
| GET | `/auth/me` | Yes | Get current user |
| POST | `/auth/logout` | Yes | Invalidate current JWT generation |
| POST | `/auth/email/request-verification` | Yes | Create email verification token |
| POST | `/auth/email/verify` | No | Verify email token |
| POST | `/auth/password/request-reset` | No | Create password reset token |
| POST | `/auth/password/reset` | No | Reset password with token |
| POST | `/auth/password/change` | Yes | Change password |
| POST | `/admin/auth/login` | No | Login as admin |
| GET | `/admin/auth/me` | Admin | Get current admin |
| POST | `/admin/auth/logout` | Admin | Invalidate current admin JWT generation |
| GET | `/admin/metrics/summary` | Admin | Get system metrics and visit totals |
| GET | `/admin/users` | Admin | List/search/filter users |
| GET | `/admin/users/:id` | Admin | Get one user |
| PATCH | `/admin/users/:id/status` | Admin | Enable or disable a user |
| GET | `/admin/audit-logs` | Admin | List audit logs |
| GET | `/google-accounts` | Yes | List connected Google accounts |
| GET | `/google-accounts/connect` | Yes | Start Google OAuth |
| GET | `/google-accounts/callback` | No | OAuth callback |
| DELETE | `/google-accounts/:id` | Yes | Disconnect Google account |
| GET | `/google-accounts/:id/quota` | Yes | Refresh one account quota |
| GET | `/files` | Yes | List/search/filter files across accounts |
| POST | `/files/upload-session` | Yes | Create Drive upload session |
| GET | `/files/upload-session/:id` | Yes | Get one upload session |
| PATCH | `/files/upload-session/:id` | Yes | Mark upload complete |
| GET | `/files/:accountId/:fileId/links` | Yes | Get Drive open/download/export links |
| DELETE | `/files/:accountId/:fileId` | Yes | Delete a Drive file |
| GET | `/storage/summary` | Yes | Get aggregated storage summary |

## 13. Testing With Postman

Import these files into Postman:

- `docs/Gmail-Aggregator.postman_collection.json`
- `docs/Gmail-Aggregator.postman_environment.json`

Recommended flow:

1. Select the `Gmail Aggregator Local` environment.
2. Run `Auth / Register`.
3. The collection test script stores `jwt_token`.
4. Run `Auth / Me`.
5. Run `Auth / Logout` only when you want to invalidate the current token.
6. Run `Google Accounts / Start Google OAuth`.
6. Open the redirect URL in a browser if Postman does not follow the Google OAuth flow cleanly.
7. After account connection, run `Google Accounts / List Accounts`.
8. Copy an account ID into `account_id`.
9. Run storage, files, upload session, and delete requests.

Google OAuth callback is difficult to fully automate in Postman because it requires an interactive browser login and consent screen. The callback request is included for manual testing.

Admin testing flow:

1. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optional `ADMIN_DISPLAY_NAME` in `.env`.
2. Run `npm run admin:create`.
3. Set the same admin credentials in the Postman environment.
4. Run `Admin / Admin Login`; Postman stores `admin_token`.
5. Run `Admin / Metrics Summary`, `Admin / List Users`, and `Admin / Audit Logs`.
6. Use `Admin / Disable User` and `Admin / Enable User` only against test users unless you intentionally want to block a real user.

## 14. Current Production Caveats

These improvements are implemented, but a few production concerns remain:

- Redis must be running for background queues and distributed rate limiting.
- Email verification/password reset send through the configured email provider. Production must set `EMAIL_PROVIDER` and provider credentials.
- File sync is queued with BullMQ when Redis is configured.
- OAuth and Drive APIs need real Google credentials and a configured PostgreSQL database to test end-to-end.
- Admin creation requires `ADMIN_EMAIL` and `ADMIN_PASSWORD`; the password must be at least 12 characters.
- Request logs can grow quickly in production. Add retention/archival once traffic becomes meaningful.
Email verification and password reset tokens are stored hashed in `AuthToken`. In development, token request endpoints return the raw token so the flow can be tested quickly. In production, they return only `{ "success": true }` and send the link through the configured email provider.
