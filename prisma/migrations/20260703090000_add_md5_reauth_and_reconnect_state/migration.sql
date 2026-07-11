-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'REAUTH_REQUIRED';

-- AlterEnum
ALTER TYPE "ActivityEventType" ADD VALUE 'ACCOUNT_REAUTH_REQUIRED';

-- AlterTable
ALTER TABLE "FileCache" ADD COLUMN "md5Checksum" TEXT;

-- AlterTable
ALTER TABLE "OAuthState" ADD COLUMN "reconnectAccountId" TEXT;

-- CreateIndex
CREATE INDEX "FileCache_accountId_md5Checksum_idx" ON "FileCache"("accountId", "md5Checksum");
