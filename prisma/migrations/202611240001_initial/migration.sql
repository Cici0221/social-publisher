-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'EDITOR', 'REVIEWER');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('ZH', 'EN', 'JA', 'VI');

-- CreateEnum
CREATE TYPE "AccountMode" AS ENUM ('LIVE', 'MOCK', 'MANUAL');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'DISABLED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'RETURNED', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('WAITING_APPROVAL', 'SCHEDULED', 'QUEUED', 'UPLOADING', 'PUBLISHING', 'PROCESSING', 'MANUAL', 'SUCCESS', 'FAILED', 'UNKNOWN', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT NOT NULL,
    "lastTotpStep" BIGINT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "digest" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("digest")
);

-- CreateTable
CREATE TABLE "LoginLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginLimit_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Preference" (
    "id" TEXT NOT NULL DEFAULT 'workspace',
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAccount" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "AccountMode" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "language" "Language" NOT NULL DEFAULT 'ZH',
    "backendUrl" TEXT,
    "credential" TEXT,
    "expiresAt" TIMESTAMP(3),
    "refreshAfter" TIMESTAMP(3),
    "refreshLease" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "digest" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifier" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("digest")
);

-- CreateTable
CREATE TABLE "AssetFolder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "thumbKey" TEXT,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PROCESSING',
    "width" INTEGER,
    "height" INTEGER,
    "duration" DOUBLE PRECISION,
    "error" TEXT,
    "uploaderId" TEXT NOT NULL,
    "folderId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "multipartId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "bytes" BIGINT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Content" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "versions" JSONB NOT NULL,
    "overrides" JSONB NOT NULL,
    "selections" JSONB NOT NULL,
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAsset" (
    "contentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,

    CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("contentId","assetId")
);

-- CreateTable
CREATE TABLE "PlatformPreset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishTask" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "publisherId" TEXT NOT NULL,
    "confirmerId" TEXT,
    "mode" "AccountMode" NOT NULL,
    "platform" TEXT NOT NULL,
    "language" "Language" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TaskStatus" NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "nextRunAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "providerState" TEXT,
    "externalId" TEXT,
    "postUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "objectId" TEXT,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "href" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "LoginLimit_expiresAt_idx" ON "LoginLimit"("expiresAt");

-- CreateIndex
CREATE INDEX "PlatformAccount_status_refreshAfter_idx" ON "PlatformAccount"("status", "refreshAfter");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAccount_platform_externalId_mode_key" ON "PlatformAccount"("platform", "externalId", "mode");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssetFolder_name_key" ON "AssetFolder"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_objectKey_key" ON "Asset"("objectKey");

-- CreateIndex
CREATE INDEX "Asset_status_createdAt_idx" ON "Asset"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Asset_folderId_idx" ON "Asset"("folderId");

-- CreateIndex
CREATE INDEX "Asset_uploaderId_idx" ON "Asset"("uploaderId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadSession_objectKey_key" ON "UploadSession"("objectKey");

-- CreateIndex
CREATE INDEX "UploadSession_ownerId_complete_idx" ON "UploadSession"("ownerId", "complete");

-- CreateIndex
CREATE INDEX "UploadSession_expiresAt_idx" ON "UploadSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Content_ownerId_status_updatedAt_idx" ON "Content"("ownerId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ContentAsset_assetId_idx" ON "ContentAsset"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPreset_ownerId_name_key" ON "PlatformPreset"("ownerId", "name");

-- CreateIndex
CREATE INDEX "Review_contentId_createdAt_idx" ON "Review"("contentId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishTask_status_nextRunAt_idx" ON "PublishTask"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "PublishTask_status_runAt_idx" ON "PublishTask"("status", "runAt");

-- CreateIndex
CREATE INDEX "PublishTask_publisherId_createdAt_idx" ON "PublishTask"("publisherId", "createdAt");

-- CreateIndex
CREATE INDEX "PublishTask_platform_createdAt_idx" ON "PublishTask"("platform", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishTask_contentId_accountId_key" ON "PublishTask"("contentId", "accountId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "AssetFolder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Content" ADD CONSTRAINT "Content_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAsset" ADD CONSTRAINT "ContentAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPreset" ADD CONSTRAINT "PlatformPreset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishTask" ADD CONSTRAINT "PublishTask_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishTask" ADD CONSTRAINT "PublishTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishTask" ADD CONSTRAINT "PublishTask_publisherId_fkey" FOREIGN KEY ("publisherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishTask" ADD CONSTRAINT "PublishTask_confirmerId_fkey" FOREIGN KEY ("confirmerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Journal entries are insert-only, including bulk deletion and table truncation.
CREATE FUNCTION deny_audit_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$;

CREATE TRIGGER "AuditLog_append_only_rows"
BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION deny_audit_rewrite();

CREATE TRIGGER "AuditLog_append_only_table"
BEFORE TRUNCATE ON "AuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION deny_audit_rewrite();
