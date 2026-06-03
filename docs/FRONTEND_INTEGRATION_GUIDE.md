# Gmail Aggregator Frontend Integration Guide

This document is the handoff spec for wiring a frontend to this backend.

The backend is a NestJS REST API for users who want to connect one or more Google accounts, view Google Drive files across those accounts, view combined storage quota, create direct-to-Google upload sessions, and delete Drive files.

Default local API base URL:

```text
http://localhost:4000
```

Swagger/OpenAPI UI:

```text
http://localhost:4000/docs/api
```

## 1. Integration Rules

### Authentication

Most user endpoints require:

```http
Authorization: Bearer <user_jwt>
```

Admin endpoints require a separate admin JWT:

```http
Authorization: Bearer <admin_jwt>
```

User auth and admin auth are separate. Do not use the normal user token on `/admin/*`.

### JSON And BigInt Fields

Byte counts and quota fields are database `BigInt` values. The backend serializes them as strings in JSON.

Treat these fields as strings in the frontend:

```text
storageLimit
storageUsed
totalLimit
totalUsed
totalFree
limit
used
free
sizeBytes
fileSize
bytesUploaded
```

Convert them to `BigInt` in the frontend only when calculating exact byte totals:

```ts
const used = BigInt(account.storageUsed);
```

For display, format as KB/MB/GB/TB.

### Error Shape

All API errors use this shape:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request",
  "timestamp": "2026-05-28T00:00:00.000Z",
  "path": "/files"
}
```

`message` may be either a string or an array of validation messages depending on the error source.

### Validation Behavior

The backend strips unknown fields and rejects non-whitelisted fields. Send only documented fields in request bodies and query strings.

### CORS

The backend accepts browser requests only from `FRONTEND_URL` in `.env`. The frontend origin must exactly match that value, including port.

## 2. Main User App Screens

Recommended screens:

1. Register
2. Login
3. Email verification notice / verify token screen
4. Forgot password / reset password
5. Dashboard
6. Connected Google accounts
7. Files browser
8. Upload flow
9. Settings / change password

Recommended admin screens:

1. Admin login
2. Metrics dashboard
3. User list
4. User detail
5. Audit logs

## 3. User Auth Flow

### Register

```http
POST /auth/register
Content-Type: application/json
```

Request:

```json
{
  "email": "user@example.com",
  "password": "password123",
  "displayName": "Victor"
}
```

Rules:

- `email` must be a valid email.
- `password` minimum length is 8.
- `displayName` is optional.

Response:

```json
{
  "token": "jwt",
  "user": {
    "id": "clx...",
    "email": "user@example.com",
    "displayName": "Victor",
    "avatarUrl": null,
    "emailVerified": false,
    "status": "ACTIVE",
    "tokenVersion": 0,
    "createdAt": "2026-05-28T00:00:00.000Z",
    "updatedAt": "2026-05-28T00:00:00.000Z"
  }
}
```

Frontend action:

- Store `token`.
- Store/render `user`.
- Redirect to dashboard or email verification screen.

Production note:

- In production, registration sends an email verification email automatically.
- In development, verification token request endpoints may return raw tokens to make local testing easy.

### Login

```http
POST /auth/login
Content-Type: application/json
```

Request:

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

Response:

```json
{
  "token": "jwt",
  "user": {
    "id": "clx...",
    "email": "user@example.com",
    "displayName": "Victor",
    "avatarUrl": null,
    "emailVerified": true,
    "status": "ACTIVE",
    "tokenVersion": 0,
    "createdAt": "2026-05-28T00:00:00.000Z",
    "updatedAt": "2026-05-28T00:00:00.000Z"
  }
}
```

Frontend action:

- Store `token`.
- Use it on all protected user requests.

### Current User

```http
GET /auth/me
Authorization: Bearer <user_jwt>
```

Response:

```json
{
  "id": "clx...",
  "email": "user@example.com",
  "displayName": "Victor",
  "avatarUrl": null,
  "emailVerified": true,
  "status": "ACTIVE",
  "tokenVersion": 0,
  "createdAt": "2026-05-28T00:00:00.000Z",
  "updatedAt": "2026-05-28T00:00:00.000Z"
}
```

Use this endpoint on app boot to validate a stored token.

### Logout

```http
POST /auth/logout
Authorization: Bearer <user_jwt>
```

Response:

```json
{ "success": true }
```

Important:

- Logout increments the user's server-side token version.
- Old JWTs stop working.
- Clear the token on the frontend immediately after success.

### Request Email Verification

```http
POST /auth/email/request-verification
Authorization: Bearer <user_jwt>
```

Request body: none.

Production response:

```json
{ "success": true }
```

Development response:

```json
{
  "success": true,
  "token": "raw-dev-token"
}
```

Frontend action:

- Show "verification email sent".
- In development, a frontend AI/test UI can expose the returned token for quick testing.

### Verify Email

```http
POST /auth/email/verify
Content-Type: application/json
```

Request:

```json
{
  "token": "verification-token"
}
```

Response:

```json
{ "success": true }
```

Frontend route suggestion:

```text
/verify-email?token=<token>
```

The page should read `token` from the query string and call this endpoint.

### Request Password Reset

```http
POST /auth/password/request-reset
Content-Type: application/json
```

Request:

```json
{
  "email": "user@example.com"
}
```

Response:

```json
{ "success": true }
```

Development may also return:

```json
{
  "success": true,
  "token": "raw-dev-token"
}
```

The backend intentionally returns success even if the email does not exist, so the frontend should always show a generic success message.

### Reset Password

```http
POST /auth/password/reset
Content-Type: application/json
```

Request:

```json
{
  "token": "password-reset-token",
  "password": "newPassword123"
}
```

Response:

```json
{ "success": true }
```

Important:

- Password minimum length is 8.
- Resetting password increments token version, invalidating existing user JWTs.

### Change Password

```http
POST /auth/password/change
Authorization: Bearer <user_jwt>
Content-Type: application/json
```

Request:

```json
{
  "currentPassword": "oldPassword123",
  "newPassword": "newPassword123"
}
```

Response:

```json
{ "success": true }
```

Important:

- This invalidates the current JWT generation.
- After success, clear the token and send the user back to login.

## 4. Google Account Connection Flow

The frontend does not exchange Google OAuth codes directly. The backend owns the OAuth callback and token storage.

### List Connected Accounts

```http
GET /google-accounts
Authorization: Bearer <user_jwt>
```

Response:

```json
[
  {
    "id": "account-id",
    "googleEmail": "gmail@example.com",
    "displayName": "Gmail User",
    "avatarUrl": "https://...",
    "storageLimit": "16106127360",
    "storageUsed": "1000000",
    "quotaUpdatedAt": "2026-05-28T00:00:00.000Z",
    "status": "ACTIVE",
    "lastSyncAt": "2026-05-28T00:00:00.000Z",
    "lastSyncError": null,
    "reauthRequiredAt": null,
    "createdAt": "2026-05-28T00:00:00.000Z"
  }
]
```

Account statuses:

```text
ACTIVE
REAUTH_REQUIRED
SYNC_FAILED
DISCONNECTED
```

Frontend display:

- `ACTIVE`: usable.
- `REAUTH_REQUIRED`: show reconnect button.
- `SYNC_FAILED`: show warning and allow retry by loading files/quota again.
- `DISCONNECTED`: normally not returned after deletion, but keep a fallback label.

### Start Google OAuth

```http
GET /google-accounts/connect
Authorization: Bearer <user_jwt>
```

Backend behavior:

- Creates one-time OAuth state.
- Redirects to Google OAuth consent screen.

Frontend action:

- Use full-page navigation, not `fetch`, because this endpoint redirects to Google.

Example:

```ts
window.location.href = `${API_BASE_URL}/google-accounts/connect`;
```

If the frontend uses token-only auth in localStorage/sessionStorage, the browser navigation will not automatically attach the `Authorization` header. In that case, use one of these approaches:

1. Open OAuth through a small frontend action that first calls the endpoint with `fetch`, reads the final redirect URL if your client follows/handles redirects, then assigns `window.location.href`.
2. Add a backend endpoint later that returns `{ url }` instead of issuing an HTTP redirect.
3. Use cookie-based auth later if the app is changed to support it.

Current backend implementation expects the user JWT guard on `/google-accounts/connect`, so the frontend must start the request in a way that sends `Authorization: Bearer <user_jwt>`.

### OAuth Callback Redirect Result

Google redirects to:

```text
GET /google-accounts/callback?code=...&state=...
```

The backend consumes the callback, stores encrypted tokens, then redirects to the frontend.

Success redirect:

```text
<FRONTEND_URL>/accounts?connected=true
```

Failure redirect:

```text
<FRONTEND_URL>/accounts?error=oauth_failed
```

Frontend action on `/accounts`:

- If `connected=true`, show success toast and call `GET /google-accounts`.
- If `error=oauth_failed`, show an error and allow retry.

### Disconnect Google Account

```http
DELETE /google-accounts/:id
Authorization: Bearer <user_jwt>
```

Response:

```json
{ "success": true }
```

Backend behavior:

- Verifies ownership.
- Attempts to revoke Google refresh token.
- Deletes the connected account row.
- Cascades related file cache/upload sessions through database relations.

### Refresh One Account Quota

```http
GET /google-accounts/:id/quota
Authorization: Bearer <user_jwt>
```

Response:

```json
{
  "id": "account-id",
  "googleEmail": "gmail@example.com",
  "displayName": "Gmail User",
  "avatarUrl": "https://...",
  "storageLimit": "16106127360",
  "storageUsed": "1000000",
  "quotaUpdatedAt": "2026-05-28T00:00:00.000Z",
  "status": "ACTIVE",
  "lastSyncAt": "2026-05-28T00:00:00.000Z",
  "lastSyncError": null,
  "reauthRequiredAt": null,
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

Use this for a manual "refresh account quota" action.

## 5. Storage Dashboard

### Get Storage Summary

```http
GET /storage/summary
Authorization: Bearer <user_jwt>
```

Response when cache is fresh:

```json
{
  "totalLimit": "32212254720",
  "totalUsed": "1000000",
  "totalFree": "32211254720",
  "accounts": [
    {
      "accountId": "account-id",
      "googleEmail": "gmail@example.com",
      "limit": "16106127360",
      "used": "1000000",
      "free": "16105127360"
    }
  ]
}
```

Response when Redis queue accepts a background refresh:

```json
{
  "totalLimit": "32212254720",
  "totalUsed": "1000000",
  "totalFree": "32211254720",
  "refreshQueued": true,
  "accounts": [
    {
      "accountId": "account-id",
      "googleEmail": "gmail@example.com",
      "limit": "16106127360",
      "used": "1000000",
      "free": "16105127360",
      "status": "ACTIVE",
      "quotaUpdatedAt": "2026-05-28T00:00:00.000Z"
    }
  ]
}
```

Frontend behavior:

- Render totals immediately.
- If `refreshQueued === true`, show a small "refreshing" state and poll again after a few seconds.
- If no accounts exist, render an empty state with a connect Google account action.

## 6. Files Browser

### List Files

```http
GET /files
Authorization: Bearer <user_jwt>
```

Query params:

```text
accountId?: string
fileType?: DOCUMENT|SPREADSHEET|PRESENTATION|PDF|IMAGE|VIDEO|AUDIO|FOLDER|OTHER
search?: string
parentId?: string
sortBy?: name|size|modifiedAt
sortOrder?: asc|desc
page?: number, default 1
limit?: number, default 50, max 200
```

Example:

```http
GET /files?accountId=account-id&fileType=PDF&search=invoice&sortBy=modifiedAt&sortOrder=desc&page=1&limit=50
```

Response:

```json
{
  "data": [
    {
      "id": "cache-row-id",
      "accountId": "account-id",
      "driveFileId": "google-drive-file-id",
      "name": "Invoice.pdf",
      "mimeType": "application/pdf",
      "fileType": "PDF",
      "sizeBytes": "123456",
      "webViewLink": "https://drive.google.com/...",
      "thumbnailLink": null,
      "driveParentId": "parent-drive-folder-id",
      "isFolder": false,
      "driveCreatedAt": "2026-05-20T00:00:00.000Z",
      "driveModifiedAt": "2026-05-28T00:00:00.000Z",
      "cachedAt": "2026-05-28T00:00:00.000Z",
      "account": {
        "id": "account-id",
        "googleEmail": "gmail@example.com",
        "displayName": "Gmail User",
        "avatarUrl": "https://..."
      }
    }
  ],
  "meta": {
    "total": 1,
    "page": 1,
    "limit": 50,
    "lastPage": 1
  }
}
```

Backend behavior:

- If cache is older than 5 minutes, backend queues a sync when Redis is available.
- If Redis is unavailable, backend syncs inline.
- First sync can take longer because it reads Drive pages.
- Later syncs use Google Drive changes where possible.

Frontend behavior:

- Use loading skeletons for first file load.
- If `data` is empty and accounts exist, show "No files found" or "sync in progress, refresh shortly".
- Use `driveParentId` and `isFolder` to implement folder navigation.
- Use `webViewLink` for "Open in Drive" when available.

### Get File Links

```http
GET /files/:accountId/:fileId/links
Authorization: Bearer <user_jwt>
```

`fileId` is the Google Drive file ID, not the cache row ID.

Response:

```json
{
  "driveFileId": "google-drive-file-id",
  "name": "Document",
  "mimeType": "application/vnd.google-apps.document",
  "webViewLink": "https://drive.google.com/...",
  "webContentLink": null,
  "exportLinks": {
    "application/pdf": "https://..."
  }
}
```

Frontend behavior:

- For normal binary files, use `webContentLink` when present.
- For Google-native Docs/Sheets/Slides, use `exportLinks` to offer export formats.
- Always offer `webViewLink` when present.

### Delete File

```http
DELETE /files/:accountId/:fileId
Authorization: Bearer <user_jwt>
```

Response:

```json
{ "success": true }
```

Important:

- This deletes the file from Google Drive.
- Show a confirmation modal before calling this endpoint.
- Remove the file from UI optimistically only after success, or restore it on error.

## 7. Upload Flow

The backend does not receive file bytes. It creates a Google Drive resumable upload session URI. The frontend uploads bytes directly to Google using that URI.

### Step 1: Create Upload Session

```http
POST /files/upload-session
Authorization: Bearer <user_jwt>
Content-Type: application/json
```

Request:

```json
{
  "accountId": "account-id",
  "fileName": "video.mp4",
  "mimeType": "video/mp4",
  "fileSize": 1048576,
  "parentId": "optional-google-drive-folder-id"
}
```

Rules:

- `accountId`, `fileName`, `mimeType` required.
- `fileSize` must be a positive integer.
- `parentId` optional. Use it to upload into a selected Drive folder.

Response:

```json
{
  "id": "upload-session-id",
  "userId": "user-id",
  "accountId": "account-id",
  "sessionUri": "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=...",
  "fileName": "video.mp4",
  "mimeType": "video/mp4",
  "fileType": "VIDEO",
  "fileSize": "1048576",
  "status": "PENDING",
  "bytesUploaded": "0",
  "driveFileId": null,
  "verifiedAt": null,
  "expiresAt": "2026-06-04T00:00:00.000Z",
  "completedAt": null,
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

Security:

- `sessionUri` is sensitive.
- Keep it only in memory for the upload flow if possible.

### Step 2: Upload Directly To Google

Send the file bytes to `sessionUri`.

Simple single-request upload:

```http
PUT <sessionUri>
Content-Type: <file.mimeType>
Content-Length: <file.size>
```

Body: raw file bytes.

Browser example:

```ts
async function uploadToGoogle(sessionUri: string, file: File) {
  const response = await fetch(sessionUri, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'Content-Length': String(file.size)
    },
    body: file
  });

  if (!response.ok) {
    throw new Error(`Google upload failed: ${response.status}`);
  }

  return response.json();
}
```

Google response contains the uploaded Drive file metadata. Capture the returned `id`.

Expected Google response shape:

```json
{
  "id": "google-drive-file-id",
  "name": "video.mp4",
  "mimeType": "video/mp4"
}
```

Note:

- Some browsers may not allow manually setting `Content-Length`; fetch will set it from the `File` body.
- For very large files, implement chunked resumable upload using Google Drive resumable upload semantics.

### Step 3: Complete Upload In Backend

After Google upload succeeds, tell the backend to verify it.

```http
PATCH /files/upload-session/:id
Authorization: Bearer <user_jwt>
Content-Type: application/json
```

Request:

```json
{
  "driveFileId": "google-drive-file-id",
  "bytesUploaded": "1048576"
}
```

Rules:

- `bytesUploaded` must be a numeric string.
- It should match `file.size`.

Response when Redis queue accepts verification:

```json
{ "queued": true }
```

Response when verification runs inline:

```json
{
  "queued": false,
  "completed": true
}
```

Backend verification checks:

- Upload session belongs to the user.
- Google Drive file exists in the selected account.
- MIME type matches.
- File size matches when Google exposes size.
- File name matches.

If verification succeeds:

- Upload session becomes `COMPLETED`.
- File cache is updated.
- Account file cache is invalidated for later refresh.

If verification fails:

- Upload session becomes `FAILED`.
- API returns an error.

### Step 4: Poll Upload Session

```http
GET /files/upload-session/:id
Authorization: Bearer <user_jwt>
```

Response:

```json
{
  "id": "upload-session-id",
  "userId": "user-id",
  "accountId": "account-id",
  "sessionUri": "https://www.googleapis.com/upload/drive/v3/files?...",
  "fileName": "video.mp4",
  "mimeType": "video/mp4",
  "fileType": "VIDEO",
  "fileSize": "1048576",
  "status": "COMPLETED",
  "bytesUploaded": "1048576",
  "driveFileId": "google-drive-file-id",
  "verifiedAt": "2026-05-28T00:00:00.000Z",
  "expiresAt": "2026-06-04T00:00:00.000Z",
  "completedAt": "2026-05-28T00:00:00.000Z",
  "createdAt": "2026-05-28T00:00:00.000Z"
}
```

Upload statuses:

```text
PENDING
IN_PROGRESS
COMPLETED
FAILED
EXPIRED
```

Frontend behavior:

- `PENDING`: session created, upload not confirmed.
- `IN_PROGRESS`: backend verification started or queued.
- `COMPLETED`: show success and refresh file list.
- `FAILED`: show error and allow retry with a new upload session.
- `EXPIRED`: create a new upload session.

## 8. Admin API

Admin auth is separate from user auth.

### Admin Login

```http
POST /admin/auth/login
Content-Type: application/json
```

Request:

```json
{
  "email": "admin@example.com",
  "password": "long-admin-password"
}
```

Response:

```json
{
  "token": "admin-jwt",
  "admin": {
    "id": "admin-id",
    "email": "admin@example.com",
    "displayName": "System Admin",
    "role": "ADMIN",
    "tokenVersion": 0,
    "lastLoginAt": "2026-05-28T00:00:00.000Z",
    "createdAt": "2026-05-28T00:00:00.000Z",
    "updatedAt": "2026-05-28T00:00:00.000Z"
  }
}
```

### Admin Me

```http
GET /admin/auth/me
Authorization: Bearer <admin_jwt>
```

Response is the safe admin object.

### Admin Logout

```http
POST /admin/auth/logout
Authorization: Bearer <admin_jwt>
```

Response:

```json
{ "success": true }
```

### Metrics Summary

```http
GET /admin/metrics/summary
Authorization: Bearer <admin_jwt>
```

Response:

```json
{
  "users": {
    "total": 10,
    "verified": 8,
    "disabled": 1
  },
  "admins": {
    "total": 1
  },
  "googleAccounts": {
    "total": 15,
    "byStatus": {
      "ACTIVE": 14,
      "REAUTH_REQUIRED": 1
    }
  },
  "files": {
    "cached": 1000
  },
  "uploads": {
    "byStatus": {
      "COMPLETED": 20,
      "FAILED": 2
    }
  },
  "storage": {
    "totalLimit": "161061273600",
    "totalUsed": "5000000000"
  },
  "visits": {
    "last24h": 120,
    "last7d": 700,
    "topPaths": [
      { "path": "/files", "count": 200 }
    ],
    "recent": [
      {
        "id": "request-id",
        "method": "GET",
        "path": "/files",
        "statusCode": 200,
        "durationMs": 55,
        "createdAt": "2026-05-28T00:00:00.000Z",
        "userId": "user-id",
        "adminId": null
      }
    ]
  }
}
```

### List Users

```http
GET /admin/users
Authorization: Bearer <admin_jwt>
```

Query params:

```text
search?: string
status?: ACTIVE|DISABLED
page?: number, default 1
limit?: number, default 50, max 200
```

Response:

```json
{
  "data": [
    {
      "id": "user-id",
      "email": "user@example.com",
      "displayName": "Victor",
      "avatarUrl": null,
      "emailVerified": true,
      "status": "ACTIVE",
      "createdAt": "2026-05-28T00:00:00.000Z",
      "updatedAt": "2026-05-28T00:00:00.000Z",
      "_count": {
        "connectedAccounts": 2,
        "uploadSessions": 5
      }
    }
  ],
  "meta": {
    "total": 1,
    "page": 1,
    "limit": 50,
    "lastPage": 1
  }
}
```

### Get User Detail

```http
GET /admin/users/:id
Authorization: Bearer <admin_jwt>
```

Response includes:

- User profile fields.
- Connected accounts.
- Last 20 upload sessions.

### Update User Status

```http
PATCH /admin/users/:id/status
Authorization: Bearer <admin_jwt>
Content-Type: application/json
```

Request:

```json
{
  "status": "DISABLED"
}
```

Allowed statuses:

```text
ACTIVE
DISABLED
```

Response:

```json
{
  "id": "user-id",
  "email": "user@example.com",
  "status": "DISABLED",
  "updatedAt": "2026-05-28T00:00:00.000Z"
}
```

Important:

- Disabling a user increments token version and invalidates existing user JWTs.

### Audit Logs

```http
GET /admin/audit-logs?page=1&limit=50
Authorization: Bearer <admin_jwt>
```

Response:

```json
{
  "data": [
    {
      "id": "audit-id",
      "userId": "user-id",
      "adminId": null,
      "action": "USER_LOGIN",
      "accountId": null,
      "resourceId": null,
      "metadata": null,
      "ipAddress": "127.0.0.1",
      "userAgent": "Mozilla/5.0",
      "createdAt": "2026-05-28T00:00:00.000Z",
      "user": {
        "id": "user-id",
        "email": "user@example.com"
      },
      "admin": null
    }
  ],
  "meta": {
    "total": 1,
    "page": 1,
    "limit": 50,
    "lastPage": 1
  }
}
```

## 9. Frontend State Model

Suggested client-side types:

```ts
type User = {
  id: string;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  emailVerified: boolean;
  status: 'ACTIVE' | 'DISABLED';
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
};

type ConnectedAccount = {
  id: string;
  googleEmail: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  storageLimit: string;
  storageUsed: string;
  quotaUpdatedAt: string;
  status: 'ACTIVE' | 'REAUTH_REQUIRED' | 'SYNC_FAILED' | 'DISCONNECTED';
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  reauthRequiredAt?: string | null;
  createdAt: string;
};

type FileCacheItem = {
  id: string;
  accountId: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  fileType: 'DOCUMENT' | 'SPREADSHEET' | 'PRESENTATION' | 'PDF' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FOLDER' | 'OTHER';
  sizeBytes: string;
  webViewLink?: string | null;
  thumbnailLink?: string | null;
  driveParentId?: string | null;
  isFolder: boolean;
  driveCreatedAt: string;
  driveModifiedAt: string;
  cachedAt: string;
  account: {
    id: string;
    googleEmail: string;
    displayName?: string | null;
    avatarUrl?: string | null;
  };
};

type UploadSession = {
  id: string;
  userId: string;
  accountId: string;
  sessionUri: string;
  fileName: string;
  mimeType: string;
  fileType: string;
  fileSize: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  bytesUploaded: string;
  driveFileId?: string | null;
  verifiedAt?: string | null;
  expiresAt: string;
  completedAt?: string | null;
  createdAt: string;
};
```

## 10. Recommended Frontend Data Flow

### App Boot

1. Read stored user token.
2. If no token, show public auth screens.
3. If token exists, call `GET /auth/me`.
4. If success, store current user and load dashboard data.
5. If `401`, clear token and show login.

### Dashboard Load

1. Call `GET /google-accounts`.
2. Call `GET /storage/summary`.
3. Show connected accounts and storage totals.
4. If no accounts, show connect Google CTA.

### Files Page Load

1. Call `GET /google-accounts` for account filter.
2. Call `GET /files` with current filters.
3. Show file list table/grid.
4. On search/filter/sort/page change, call `GET /files` again.

### Google Connect Return

1. User lands on `/accounts?connected=true`.
2. Show success toast.
3. Call `GET /google-accounts`.
4. Call `GET /storage/summary`.

### Upload

1. User selects account, file, and optional folder.
2. Call `POST /files/upload-session`.
3. Upload file bytes to `sessionUri`.
4. Read `driveFileId` from Google response.
5. Call `PATCH /files/upload-session/:id`.
6. If queued, poll `GET /files/upload-session/:id`.
7. Refresh `GET /files`.
8. Refresh `GET /storage/summary`.

## 11. Common Status Codes

```text
200 OK: success
201 Created: created resource, typical Nest behavior for POST
400 Bad Request: validation failure, invalid/expired token, upload verification mismatch
401 Unauthorized: missing/invalid JWT, wrong login credentials
403 Forbidden: resource does not belong to user, Drive access forbidden
404 Not Found: resource/file not found
409 Conflict: email already registered, Google account connected to another user
429 Too Many Requests: rate limit hit
503 Service Unavailable: Google Drive API unavailable
```

## 12. Frontend Implementation Notes

- Store user and admin tokens separately.
- Use an API client wrapper that injects the right bearer token.
- On any `401`, clear the relevant token and redirect to login.
- Do not assume storage/file byte fields are numbers.
- Do not expose `sessionUri` outside the upload screen.
- Confirm before deleting a Drive file.
- Use `account.status`, `lastSyncError`, and `reauthRequiredAt` to show actionable account health.
- For Google OAuth, ensure the backend receives the user's bearer token when starting `/google-accounts/connect`.
- The backend currently redirects OAuth result to `/accounts`, so the frontend should implement that route.
