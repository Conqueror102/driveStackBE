# DriveStack Backend

NestJS REST API for aggregating Google Drive storage across multiple Google accounts per authenticated user. This backend includes a complete payment and subscription engine powered by Dodo Payments, an advanced referral system, Geo-IP based localized pricing, and a robust admin dashboard.

## Key Features

- **Google Drive Aggregation**: Connect multiple Google accounts, view combined storage quotas, caching, and file browsing.
- **Advanced File Management**: Move files between connected accounts, upload from URL, automated duplicate detection, and file preview logic.
- **Subscriptions & Billing (Dodo Payments)**: Tiered subscriptions (`FREE` vs `PRO`). The system seamlessly handles trial logic, webhook event processing (idempotent), cancellations, refunds, and dispute down-grades.
- **Country & Currency Detection**: Uses `ipapi.co` to detect user country on signup and dynamically routes them to localized pricing (`NGN` or `USD`).
- **Referral Engine**: Users can refer others to earn extra Google account slots (up to 3 bonus slots). The system tracks conversions via webhooks and automatically grants/revokes rewards.
- **Admin Dashboard & Analytics**: Custom `PricingConfig` overrides, manual subscription upgrades, full audit logging of administrative changes, and a real-time revenue summary.
- **Security**: Strict webhook signature validation via `standardwebhooks`, isolated admin JWTs, AES-256-GCM encryption for Google OAuth tokens, and rate-limiting.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy environment variables:

```bash
cp .env.example .env
```

3. Generate an encryption key:

```bash
openssl rand -hex 32
```

Set the result as `ENCRYPTION_KEY`. Set `JWT_SECRET` to at least 32 characters.

4. Run Prisma migrations:

```bash
npm run prisma:migrate
npm run prisma:generate
```

5. Start the API:

```bash
npm run start:dev
```

The default API port is `4000`.

## Environment

```env
DATABASE_URL=postgresql://user:password@localhost:5432/driveapp
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:3001

# Auth & Security
JWT_SECRET=
JWT_EXPIRES_IN=7d
ENCRYPTION_KEY=
REQUEST_LOG_SALT=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/google-accounts/callback

# Payments & Billing (Dodo)
DODO_API_KEY=
DODO_WEBHOOK_SECRET=
DODO_PRO_PRODUCT_ID_NGN=
DODO_PRO_PRODUCT_ID_USD=

# Geo-IP (Optional)
IPINFO_TOKEN=

# Redis (Caching & Queues)
REDIS_URL=redis://localhost:6379

# Admin Credentials
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_DISPLAY_NAME=
ADMIN_SECRET=

# Email Config
EMAIL_PROVIDER=console
EMAIL_FROM=no-reply@example.com
SENDGRID_API_KEY=
RESEND_API_KEY=
ZOHO_API_KEY=
ZOHO_API_URL=https://api.zeptomail.com/v1.1/email
EMAIL_HTTP_URL=
EMAIL_HTTP_AUTH_HEADER=
EMAIL_HTTP_PROVIDER_NAME=custom_http
```

## API

### Auth

`POST /auth/register` public

Registers a new user, auto-detects country for billing, provisions a FREE subscription, and accepts optional referral code.

Request:

```json
{ "email": "user@example.com", "password": "password123", "displayName": "User", "referralCode": "OPTIONAL_CODE" }
```

Response:

```json
{ "token": "jwt", "user": { "id": "cuid", "email": "user@example.com", "country": "US" } }
```

`POST /auth/login` public

Request:

```json
{ "email": "user@example.com", "password": "password123" }
```

Response:

```json
{ "token": "jwt", "user": { "id": "cuid", "email": "user@example.com" } }
```

`GET /auth/me` protected

Returns the authenticated user including their current billing `currency`, `subscription` state, and `bonusSlots`.

`PATCH /auth/country` protected

Allows users to override their auto-detected billing country.

`POST /auth/logout` protected

Invalidates the current JWT generation by incrementing the user's token version.

### Payments & Referrals

`POST /payments/checkout` protected

Generates a Dodo Payments checkout session based on the user's localized currency (`USD` or `NGN`).

`POST /payments/cancel` protected

Cancels an active PRO subscription. Access continues until the end of the billing period.

`GET /payments/portal` protected

Generates a link to the Dodo Payments customer portal.

`POST /payments/webhook` public

Receives incoming events from Dodo Payments (using `express.raw` for signature verification) to idempotently update subscriptions, payments, and referrals.

`GET /referrals/stats` protected

Retrieves the current user's shareable referral link, conversion history, and accumulated bonus slots.

### Admin

Create or update the first admin from environment variables:

```bash
npm run admin:create
```

Admin authentication is separate from normal user authentication. Admin endpoints use their own JWT from `POST /admin/auth/login`.

`POST /admin/auth/login` public

Request:

```json
{ "email": "admin@example.com", "password": "use-a-long-password" }
```

`GET /admin/metrics/summary` admin protected

Returns system totals for users, connected Google accounts, cached files, uploads, visits/requests, and recent request volume.

`GET /admin/revenue` admin protected

Returns total revenue, transaction counts, and active subscriptions.

`GET /admin/users` admin protected

Query parameters:

```text
search?, status=ACTIVE|DISABLED, page?, limit?
```

`GET /admin/users/:id` admin protected

Returns one user with connected account, subscription, and usage context.

`PATCH /admin/users/:id/status` admin protected

Request:

```json
{ "status": "DISABLED" }
```

Use `ACTIVE` to enable the user again. Disabling a user increments their token version, so existing user JWTs stop working.

`POST /admin/users/:userId/upgrade` admin protected

Manually grants a PRO subscription to a user.

`PUT /admin/pricing` admin protected

Dynamically overrides the `productId` mapping for a given currency without requiring a restart.

`GET /admin/audit-logs` admin protected

Returns paginated audit logs detailing sensitive system and administrative events.

`POST /admin/auth/logout` admin protected

Invalidates the current admin JWT generation.

### Google Accounts

`GET /google-accounts` protected

Lists connected accounts. Tokens are never returned.

`GET /google-accounts/connect` protected

Redirects to Google OAuth consent.

`GET /google-accounts/callback?code=...&state=...` public

Handles Google OAuth callback and redirects to the frontend.

`DELETE /google-accounts/:id` protected

Disconnects an owned Google account.

`GET /google-accounts/:id/quota` protected

Refreshes quota for one owned account.

### Files

`GET /files` protected

Query parameters:

```text
accountId?, fileType?, search?, parentId?, sortBy=name|size|modifiedAt, sortOrder=asc|desc, page?, limit?
```

Response:

```json
{
  "data": [
    {
      "id": "cache-id",
      "driveFileId": "drive-id",
      "name": "file.pdf",
      "fileType": "PDF",
      "mimeType": "application/pdf",
      "sizeBytes": "1234",
      "webViewLink": null,
      "thumbnailLink": null,
      "isFolder": false,
      "driveModifiedAt": "2026-05-28T00:00:00.000Z",
      "account": { "id": "account-id", "googleEmail": "g@example.com" }
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 50, "lastPage": 1 }
}
```

`POST /files/upload-session` protected

Request:

```json
{ "accountId": "account-id", "fileName": "video.mp4", "mimeType": "video/mp4", "fileSize": 1048576 }
```

Returns an `UploadSession` including `sessionUri`.

`GET /files/upload-session/:id` protected

Returns one owned `UploadSession` including `sessionUri`.

`PATCH /files/upload-session/:id` protected

Request:

```json
{ "driveFileId": "drive-id", "bytesUploaded": "1048576" }
```

Response:

```json
{ "success": true }
```

`DELETE /files/:accountId/:fileId` protected

Deletes a Drive file from a specific owned account and invalidates cache.

### Storage

`GET /storage/summary` protected

Response:

```json
{
  "totalLimit": "32212254720",
  "totalUsed": "1000",
  "totalFree": "32212253720",
  "accounts": [
    {
      "accountId": "account-id",
      "googleEmail": "g@example.com",
      "limit": "16106127360",
      "used": "1000",
      "free": "16106126360"
    }
  ]
}
```

## Scheduled Jobs

Cron jobs run autonomously to keep the system clean:
- `Expire Upload Sessions`: Daily cleanup of abandoned uploads.
- `Check Grace Periods`: Hourly check. Degrades `ON_HOLD` users to `FREE` once the 3-day grace period passes.
- `Expire Cancelled Subscriptions`: Daily check to drop `CANCELLED` users to `FREE` upon reaching their cycle end date.
- `Expire Referrals`: Daily cleanup marking pending referrals older than 30 days as `EXPIRED`.
- `Storage Alerts`: Runs every 6 hours checking if user accounts have exceeded their alert threshold limits.
- `Duplicate Scans`: Runs daily for all active users to find redundant files.

## Notes

OAuth tokens are encrypted with AES-256-GCM before storage. OAuth state is one-time use and stored hashed. BigInt JSON serialization is patched in `src/main.ts` so byte counts are emitted as strings.

The API also includes global one-user-per-Google-account enforcement, account health fields, audit logging, request/visit tracking, upload completion verification against Google Drive, incremental Drive sync with `changes.list`, token revocation on disconnect, JWT token-version invalidation, provider-based email delivery, Redis-backed queues/rate limiting with in-memory fallback, admin APIs, and Swagger docs at `/docs/api`.
