-- CreateEnum
CREATE TYPE "MovePhase" AS ENUM ('PREPARING', 'COPYING_NATIVE', 'DOWNLOADING', 'UPLOADING', 'CREATING_FOLDER', 'MOVING_CHILDREN', 'TRASHING_SOURCE', 'SYNCING_CACHE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM ('UPLOAD_COMPLETED', 'URL_UPLOAD_COMPLETED', 'FILE_MOVED', 'MOVE_FAILED', 'FILE_TRASHED', 'FILE_RESTORED', 'DUPLICATE_SCAN_COMPLETED', 'STORAGE_ALERT');

-- AlterTable
ALTER TABLE "MoveOperation" ADD COLUMN "phase" "MovePhase" NOT NULL DEFAULT 'PREPARING';
ALTER TABLE "MoveOperation" ADD COLUMN "bytesTransferred" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "MoveOperation" ADD COLUMN "totalBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "MoveOperation" ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MoveOperation" ADD COLUMN "totalItems" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "MoveOperation" ADD COLUMN "completedItems" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ActivityEventType" NOT NULL,
    "message" TEXT NOT NULL,
    "accountId" TEXT,
    "fileId" TEXT,
    "operationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedSearch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "search" TEXT,
    "accountId" TEXT,
    "fileType" "FileType",
    "minSizeBytes" BIGINT,
    "maxSizeBytes" BIGINT,
    "modifiedAfter" TIMESTAMP(3),
    "modifiedBefore" TIMESTAMP(3),
    "sortBy" TEXT NOT NULL DEFAULT 'modifiedAt',
    "sortOrder" TEXT NOT NULL DEFAULT 'desc',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedSearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityEvent_userId_createdAt_idx" ON "ActivityEvent"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ActivityEvent_userId_type_idx" ON "ActivityEvent"("userId", "type");

-- CreateIndex
CREATE INDEX "ActivityEvent_operationId_idx" ON "ActivityEvent"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedSearch_userId_name_key" ON "SavedSearch"("userId", "name");

-- CreateIndex
CREATE INDEX "SavedSearch_userId_idx" ON "SavedSearch"("userId");

-- AddForeignKey
ALTER TABLE "ActivityEvent" ADD CONSTRAINT "ActivityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedSearch" ADD CONSTRAINT "SavedSearch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
