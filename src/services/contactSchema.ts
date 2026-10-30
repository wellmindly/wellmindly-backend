import prisma from '../lib/prisma';

let contactSchemaInitialized = false;
let schemaInitializationPromise: Promise<void> | null = null;

/**
 * Ensures that the ContactRequest table has all required columns
 * (normalizedEmail, status, verifiedAt, verificationTokenHash, verificationExpiresAt, subscriptionKey)
 * and that the ArchivedFakeContactRequest table exists.
 *
 * Runs non-destructively and idempotently (IF NOT EXISTS).
 */
export async function ensureContactRequestSchema(): Promise<void> {
  if (contactSchemaInitialized) return;
  if (typeof (prisma as any).$executeRawUnsafe !== 'function') return;
  if (schemaInitializationPromise) return schemaInitializationPromise;

  schemaInitializationPromise = (async () => {
    try {
      // 1. Add missing columns to ContactRequest if not present
      await prisma.$executeRawUnsafe(`
        ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "normalizedEmail" TEXT;
        ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'VERIFIED';
        ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
        ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verificationTokenHash" TEXT;
        ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verificationExpiresAt" TIMESTAMP(3);
        ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "subscriptionKey" TEXT;
      `);

      // 2. Populate normalizedEmail for existing records where it is null
      await prisma.$executeRawUnsafe(`
        UPDATE "ContactRequest"
        SET "normalizedEmail" = LOWER(TRIM("email"))
        WHERE "normalizedEmail" IS NULL;
      `);

      // 3. Create the ArchivedFakeContactRequest quarantine table if not present
      await prisma.$executeRawUnsafe(`
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
      `);

      // 4. Safe indexes (non-unique first; unique on subscriptionKey once deduplicated)
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "ArchivedFakeContactRequest_normalizedEmail_idx" ON "ArchivedFakeContactRequest"("normalizedEmail");
        CREATE INDEX IF NOT EXISTS "ArchivedFakeContactRequest_archivedAt_idx" ON "ArchivedFakeContactRequest"("archivedAt");
        CREATE INDEX IF NOT EXISTS "ContactRequest_normalizedEmail_idx" ON "ContactRequest"("normalizedEmail");
        CREATE INDEX IF NOT EXISTS "ContactRequest_status_idx" ON "ContactRequest"("status");
      `);

      contactSchemaInitialized = true;
      console.log('[Schema] ContactRequest & ArchivedFakeContactRequest schema verified.');
    } catch (err: any) {
      console.warn('[Schema] Warning during ensureContactRequestSchema:', err?.message || err);
      // Reset initialization promise so subsequent requests can re-attempt if DB was momentarily starting up
      schemaInitializationPromise = null;
    }
  })();

  return schemaInitializationPromise;
}
