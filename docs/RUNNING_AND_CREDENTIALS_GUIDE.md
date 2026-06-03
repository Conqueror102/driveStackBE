# Gmail Aggregator Running And Credentials Guide

This document lists what must be installed, created, and configured before the backend can run end-to-end.

## 1. Local Requirements

Install:

```text
Node.js
npm
PostgreSQL
Redis
OpenSSL or another way to generate a 32-byte hex key
```

Project dependencies are already defined in `package.json`.

Install dependencies:

```bash
npm install
```

On Windows PowerShell, if `npm` is blocked by execution policy, use:

```bash
npm.cmd install
```

## 2. Environment File

Copy:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Required `.env` shape:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/driveapp

JWT_SECRET=
JWT_EXPIRES_IN=7d

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:4000/google-accounts/callback

ENCRYPTION_KEY=

FRONTEND_URL=http://localhost:3001
REDIS_URL=redis://localhost:6379

EMAIL_PROVIDER=console
EMAIL_FROM=no-reply@example.com
SENDGRID_API_KEY=
RESEND_API_KEY=
ZOHO_API_KEY=
ZOHO_API_URL=https://api.zeptomail.com/v1.1/email
EMAIL_HTTP_URL=
EMAIL_HTTP_AUTH_HEADER=
EMAIL_HTTP_PROVIDER_NAME=custom_http

ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_DISPLAY_NAME=
REQUEST_LOG_SALT=

PORT=4000
NODE_ENV=development
```

Important correction:

- `GOOGLE_REDIRECT_URI` must point to the backend callback route, not the frontend.
- For local backend on port `4000`, use:

```env
GOOGLE_REDIRECT_URI=http://localhost:4000/google-accounts/callback
```

The frontend receives the final OAuth result through:

```text
<FRONTEND_URL>/accounts?connected=true
<FRONTEND_URL>/accounts?error=oauth_failed
```

## 3. Generate Secrets

### JWT Secret

Set `JWT_SECRET` to a long random string with at least 32 characters.

Example:

```env
JWT_SECRET=replace-with-a-long-random-string-at-least-32-chars
```

The app refuses to start if this value is missing or shorter than 32 characters.

### Encryption Key

`ENCRYPTION_KEY` must be a 64-character hex string. It is used for AES-256-GCM encryption of Google OAuth access and refresh tokens.

Generate:

```bash
openssl rand -hex 32
```

Example:

```env
ENCRYPTION_KEY=1f0d...64_hex_chars_total
```

Do not change this key after users connect Google accounts. If it changes, existing encrypted Google tokens cannot be decrypted.

### Request Log Salt

`REQUEST_LOG_SALT` is optional but recommended in production. It salts request IP hashes.

If missing, the backend falls back to `JWT_SECRET`.

## 4. PostgreSQL Setup

Create a database:

```sql
CREATE DATABASE driveapp;
```

Set:

```env
DATABASE_URL=postgresql://<user>:<password>@localhost:5432/driveapp
```

Then run:

```bash
npm run prisma:generate
npm run prisma:migrate
```

What migrations create:

- Users
- Admins
- Connected Google accounts
- Encrypted OAuth token storage
- File cache
- Upload sessions
- OAuth state records
- Auth tokens for email verification/password reset
- Sync jobs
- Audit logs
- Request logs

## 5. Redis Setup

Redis is used for:

- Distributed rate limiting
- Background file sync queue
- Background quota refresh queue
- Token refresh retry queue
- Upload verification queue

Set:

```env
REDIS_URL=redis://localhost:6379
```

The app can run without Redis in development, but behavior changes:

- Rate limiting falls back to in-memory buckets.
- Queued jobs are disabled.
- Some operations run inline instead of in workers.

For production, use Redis.

## 6. Google Cloud Setup

This is required for Google OAuth and Google Drive access.

### Step 1: Create Or Choose A Google Cloud Project

Go to Google Cloud Console and create/select a project.

You need access to:

- Google Cloud Console
- OAuth consent screen
- Credentials
- API Library

### Step 2: Enable APIs

Enable these APIs:

```text
Google Drive API
Google OAuth2 / People basic profile access through OAuth scopes
```

The app uses:

```text
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

The `drive` scope allows the backend to list, upload, view metadata, and delete Drive files for connected accounts.

### Step 3: Configure OAuth Consent Screen

Configure:

```text
App name
User support email
Developer contact email
Authorized domains for production
Scopes
Test users if the app is in Testing mode
```

Scopes to add:

```text
.../auth/drive
.../auth/userinfo.email
.../auth/userinfo.profile
```

Development note:

- If the consent screen is in Testing mode, only added test users can connect accounts.
- Add every Gmail account you plan to test with under OAuth test users.

Production note:

- The full Drive scope is sensitive/restricted.
- A real production app may require Google OAuth app verification.

### Step 4: Create OAuth Client Credentials

Create:

```text
Application type: Web application
```

Add Authorized JavaScript origins:

```text
http://localhost:3001
```

Also add your production frontend origin later:

```text
https://your-frontend-domain.com
```

Add Authorized redirect URIs:

```text
http://localhost:4000/google-accounts/callback
```

Also add your production backend callback later:

```text
https://your-api-domain.com/google-accounts/callback
```

Copy:

```text
Client ID
Client secret
```

Set:

```env
GOOGLE_CLIENT_ID=<client-id>
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_REDIRECT_URI=http://localhost:4000/google-accounts/callback
```

### Step 5: Match Redirect URI Exactly

Google requires exact redirect URI matches.

These are different values:

```text
http://localhost:4000/google-accounts/callback
http://localhost:3000/google-accounts/callback
http://127.0.0.1:4000/google-accounts/callback
```

The value in Google Cloud Console must exactly match `GOOGLE_REDIRECT_URI`.

## 7. Email Provider Setup

Email is used for:

- Email verification
- Password reset

Supported providers:

```text
console
sendgrid
resend
zoho
custom_http
```

### Development

Use console:

```env
EMAIL_PROVIDER=console
EMAIL_FROM=no-reply@example.com
NODE_ENV=development
```

In development, token request endpoints can return the raw token in JSON, which helps test email verification and password reset without a real email provider.

### SendGrid

Get from SendGrid:

```text
API key
Verified sender email/domain
```

Set:

```env
EMAIL_PROVIDER=sendgrid
EMAIL_FROM=no-reply@yourdomain.com
SENDGRID_API_KEY=<sendgrid-api-key>
```

### Resend

Get from Resend:

```text
API key
Verified sender domain/email
```

Set:

```env
EMAIL_PROVIDER=resend
EMAIL_FROM=no-reply@yourdomain.com
RESEND_API_KEY=<resend-api-key>
```

### Zoho / ZeptoMail

Get from Zoho/ZeptoMail:

```text
API key
Verified sender
API URL
```

Set:

```env
EMAIL_PROVIDER=zoho
EMAIL_FROM=no-reply@yourdomain.com
ZOHO_API_KEY=<zoho-api-key>
ZOHO_API_URL=https://api.zeptomail.com/v1.1/email
```

### Custom HTTP Provider

Use when you have another email service behind an HTTP endpoint.

Set:

```env
EMAIL_PROVIDER=custom_http
EMAIL_FROM=no-reply@yourdomain.com
EMAIL_HTTP_URL=https://your-email-service.example.com/send
EMAIL_HTTP_AUTH_HEADER=Bearer your-token
EMAIL_HTTP_PROVIDER_NAME=custom_http
```

The provider sends a generic JSON payload to `EMAIL_HTTP_URL`.

## 8. Admin Setup

Set:

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=use-a-long-password
ADMIN_DISPLAY_NAME=System Admin
```

Password requirement:

```text
ADMIN_PASSWORD must be at least 12 characters.
```

Create or update the admin:

```bash
npm run admin:create
```

Admin login endpoint:

```text
POST /admin/auth/login
```

Admin users are stored separately from normal users.

## 9. Start The App

Development:

```bash
npm run start:dev
```

Production build:

```bash
npm run build
npm run start:prod
```

Default API port:

```text
4000
```

Health check is not currently defined as a dedicated endpoint. Use Swagger or a known route such as:

```text
GET http://localhost:4000/docs/api
```

## 10. End-To-End Local Test Checklist

1. PostgreSQL is running.
2. Redis is running.
3. `.env` exists.
4. `DATABASE_URL` points to a reachable database.
5. `JWT_SECRET` is at least 32 characters.
6. `ENCRYPTION_KEY` is 64 hex characters.
7. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
8. `GOOGLE_REDIRECT_URI` is exactly registered in Google Cloud.
9. `FRONTEND_URL` matches the actual frontend dev server origin.
10. `npm run prisma:migrate` has run.
11. `npm run admin:create` has run if admin UI is needed.
12. Backend is running on `PORT`.
13. Frontend can call `POST /auth/register`.
14. Frontend can start Google connect and land back on `/accounts?connected=true`.

## 11. Production Checklist

Required production values:

```env
NODE_ENV=production
DATABASE_URL=<managed-postgres-url>
REDIS_URL=<managed-redis-url>
JWT_SECRET=<strong-random-secret>
ENCRYPTION_KEY=<64-char-hex-key-kept-permanently>
FRONTEND_URL=https://your-frontend-domain.com
GOOGLE_CLIENT_ID=<prod-google-client-id>
GOOGLE_CLIENT_SECRET=<prod-google-client-secret>
GOOGLE_REDIRECT_URI=https://your-api-domain.com/google-accounts/callback
EMAIL_PROVIDER=<sendgrid|resend|zoho|custom_http>
EMAIL_FROM=no-reply@yourdomain.com
REQUEST_LOG_SALT=<strong-random-salt>
PORT=4000
```

Production Google Cloud values:

- Add production frontend origin to Authorized JavaScript origins.
- Add production backend callback to Authorized redirect URIs.
- Add authorized domain for the frontend/API domain as needed.
- Complete OAuth verification if Google requires it for Drive scope.

Production database:

- Run migrations during deploy.
- Back up PostgreSQL.
- Do not rotate `ENCRYPTION_KEY` without a migration plan.

Production Redis:

- Use a persistent managed Redis or equivalent.
- Keep `REDIS_URL` configured so queues and rate limiting work across instances.

Production email:

- Do not use `EMAIL_PROVIDER=console`.
- Verify sender/domain with the provider.
- Confirm verification/reset links point to the frontend routes.

## 12. Important OAuth Notes For The Frontend AI

The backend route `GET /google-accounts/connect` is protected by JWT auth and currently returns an HTTP redirect to Google.

This means a plain browser navigation like this may fail because it cannot attach the bearer token:

```ts
window.location.href = `${API_BASE_URL}/google-accounts/connect`;
```

A frontend implementation should either:

1. Start OAuth using an API call that includes `Authorization: Bearer <token>` and handles the redirect URL, or
2. Ask the backend to expose a JSON endpoint that returns `{ url }`, or
3. Move auth to HTTP-only cookies in a later backend change.

The current backend already has the service method needed to create a URL, but the controller uses Nest `@Redirect()`. If the frontend AI cannot make bearer-auth redirects work cleanly, the smallest backend improvement is:

```text
GET /google-accounts/connect-url
Authorization: Bearer <user_jwt>

Response:
{ "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

Then the frontend can do:

```ts
const { url } = await api.get('/google-accounts/connect-url');
window.location.href = url;
```

## 13. What To Give The Frontend AI

Give it these files:

```text
docs/FRONTEND_INTEGRATION_GUIDE.md
docs/RUNNING_AND_CREDENTIALS_GUIDE.md
docs/Gmail-Aggregator.postman_collection.json
docs/Gmail-Aggregator.postman_environment.json
```

Also tell it:

```text
API base URL in local development: http://localhost:4000
Frontend local URL expected by backend: http://localhost:3001
OAuth result route to implement: /accounts
User token and admin token must be stored separately.
Byte and quota fields arrive as strings.
```
