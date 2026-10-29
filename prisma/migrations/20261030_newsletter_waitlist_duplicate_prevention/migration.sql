-- Migration: 20261030_newsletter_waitlist_duplicate_prevention
-- Safe, reversible migration to prevent duplicate newsletter/waitlist subscriptions,
-- enforce database-level unique constraints, and support double opt-in verification.

BEGIN;

-- 1. Create a complete archival snapshot of the existing ContactRequest table before modifications
CREATE TABLE IF NOT EXISTS "_archive_contact_requests_backup" AS
SELECT * FROM "ContactRequest";

-- 2. Add new columns for normalization, verification workflow, and unique subscription key
ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "normalizedEmail" TEXT;
ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'VERIFIED';
ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verificationTokenHash" TEXT;
ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verificationExpiresAt" TIMESTAMP(3);
ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "subscriptionKey" TEXT;

-- 3. Populate normalizedEmail for all existing records
UPDATE "ContactRequest"
SET "normalizedEmail" = LOWER(TRIM("email"))
WHERE "normalizedEmail" IS NULL;

-- 4. Create an archival table to preserve any consolidated duplicate rows with full audit trail
CREATE TABLE IF NOT EXISTS "_archive_contact_request_duplicates" (
  "id" TEXT PRIMARY KEY,
  "originalId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "normalizedEmail" TEXT NOT NULL,
  "subject" TEXT,
  "message" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "primaryRecordId" TEXT NOT NULL,
  "duplicateCount" INTEGER NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL DEFAULT 'MIGRATION_DUPLICATE_CONSOLIDATION'
);

-- 5. Consolidate duplicates among newsletter/waitlist subscriptions:
-- We retain the earliest record (MIN(createdAt), MIN(id)) to preserve original subscriber timestamps.
-- All other duplicate instances are safely archived before being removed from the active table.

WITH RankedSubscribers AS (
  SELECT
    "id",
    "name",
    "email",
    "normalizedEmail",
    "subject",
    "message",
    "createdAt",
    FIRST_VALUE("id") OVER (
      PARTITION BY "normalizedEmail", LOWER(TRIM(COALESCE("subject", '')))
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS primary_id,
    COUNT(*) OVER (
      PARTITION BY "normalizedEmail", LOWER(TRIM(COALESCE("subject", '')))
    ) AS total_count,
    ROW_NUMBER() OVER (
      PARTITION BY "normalizedEmail", LOWER(TRIM(COALESCE("subject", '')))
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS row_num
  FROM "ContactRequest"
  WHERE "name" IN ('Newsletter Subscriber', 'Newsletter Waitlist')
     OR "subject" ILIKE '%waitlist%'
     OR "subject" ILIKE '%newsletter%'
)
INSERT INTO "_archive_contact_request_duplicates" (
  "id", "originalId", "name", "email", "normalizedEmail", "subject", "message", "createdAt", "primaryRecordId", "duplicateCount", "archivedAt", "reason"
)
SELECT
  'arch_' || r."id",
  r."id",
  r."name",
  r."email",
  r."normalizedEmail",
  r."subject",
  r."message",
  r."createdAt",
  r.primary_id,
  r.total_count,
  CURRENT_TIMESTAMP,
  'MIGRATION_DUPLICATE_CONSOLIDATION'
FROM RankedSubscribers r
WHERE r.row_num > 1
ON CONFLICT ("id") DO NOTHING;

-- Remove the duplicate rows from the active ContactRequest table (now safely preserved in archive)
DELETE FROM "ContactRequest"
WHERE "id" IN (
  SELECT "originalId" FROM "_archive_contact_request_duplicates"
);

-- 6. For all retained newsletter/waitlist records, assign their unique subscriptionKey
-- and ensure their status is VERIFIED so legitimate pre-existing subscribers remain active.
UPDATE "ContactRequest"
SET "subscriptionKey" = "normalizedEmail" || '::' || LOWER(TRIM(COALESCE("subject", 'waitlist'))),
    "status" = 'VERIFIED'
WHERE ("name" IN ('Newsletter Subscriber', 'Newsletter Waitlist')
   OR "subject" ILIKE '%waitlist%'
   OR "subject" ILIKE '%newsletter%')
  AND "subscriptionKey" IS NULL;

-- 7. Create dedicated archive table for quarantined fake/bot submissions
CREATE TABLE IF NOT EXISTS "ArchivedFakeContactRequest" (
  "id" TEXT PRIMARY KEY,
  "originalId" TEXT,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "normalizedEmail" TEXT,
  "subject" TEXT,
  "message" TEXT NOT NULL,
  "classificationReasons" TEXT,
  "botScore" INTEGER NOT NULL DEFAULT 100,
  "originalCreatedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ArchivedFakeContactRequest_normalizedEmail_idx" ON "ArchivedFakeContactRequest"("normalizedEmail");
CREATE INDEX IF NOT EXISTS "ArchivedFakeContactRequest_archivedAt_idx" ON "ArchivedFakeContactRequest"("archivedAt");

-- 8. Add database-level unique constraint on subscriptionKey and performance indexes
CREATE UNIQUE INDEX IF NOT EXISTS "ContactRequest_subscriptionKey_key" ON "ContactRequest"("subscriptionKey");
CREATE INDEX IF NOT EXISTS "ContactRequest_normalizedEmail_idx" ON "ContactRequest"("normalizedEmail");
CREATE INDEX IF NOT EXISTS "ContactRequest_status_idx" ON "ContactRequest"("status");

COMMIT;
