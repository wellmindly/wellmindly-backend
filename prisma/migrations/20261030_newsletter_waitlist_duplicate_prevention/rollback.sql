-- Rollback: 20261030_newsletter_waitlist_duplicate_prevention
-- Safely reverts the migration, restoring duplicate records from archive if desired
-- and dropping the unique index and added columns.

BEGIN;

-- 1. Drop the added indexes and unique constraints
DROP INDEX IF EXISTS "ContactRequest_subscriptionKey_key";
DROP INDEX IF EXISTS "ContactRequest_normalizedEmail_idx";
DROP INDEX IF EXISTS "ContactRequest_status_idx";

-- 2. Restore any archived duplicate rows back into ContactRequest if they were removed
INSERT INTO "ContactRequest" ("id", "name", "email", "subject", "message", "createdAt")
SELECT "originalId", "name", "email", "subject", "message", "createdAt"
FROM "_archive_contact_request_duplicates"
ON CONFLICT ("id") DO NOTHING;

-- 3. Drop the added columns
ALTER TABLE "ContactRequest" DROP COLUMN IF EXISTS "subscriptionKey";
ALTER TABLE "ContactRequest" DROP COLUMN IF EXISTS "verificationExpiresAt";
ALTER TABLE "ContactRequest" DROP COLUMN IF EXISTS "verificationTokenHash";
ALTER TABLE "ContactRequest" DROP COLUMN IF EXISTS "verifiedAt";
ALTER TABLE "ContactRequest" DROP COLUMN IF EXISTS "status";
ALTER TABLE "ContactRequest" DROP COLUMN IF EXISTS "normalizedEmail";

COMMIT;
