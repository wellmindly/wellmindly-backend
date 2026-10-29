"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeSubscribers = analyzeSubscribers;
const prisma_1 = __importDefault(require("../src/lib/prisma"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function analyzeSubscribers(records) {
    const isNewsletterWaitlist = (r) => {
        const nameMatch = r.name === 'Newsletter Subscriber' || r.name === 'Newsletter Waitlist';
        const subjMatch = (r.subject || '').toLowerCase().includes('waitlist') || (r.subject || '').toLowerCase().includes('newsletter');
        return nameMatch || subjMatch;
    };
    const waitlistRecords = records.filter(isNewsletterWaitlist);
    const groups = new Map();
    const dailyDistribution = new Map();
    for (const record of waitlistRecords) {
        const normEmail = record.email.trim().toLowerCase();
        const campaign = (record.subject || 'Waitlist: Human Counselling for All Students').trim().toLowerCase();
        const key = `${normEmail}::${campaign}`;
        const existing = groups.get(key) || [];
        existing.push(record);
        groups.set(key, existing);
        const dateKey = new Date(record.createdAt).toISOString().split('T')[0];
        dailyDistribution.set(dateKey, (dailyDistribution.get(dateKey) || 0) + 1);
    }
    const duplicates = [];
    let totalDuplicates = 0;
    for (const [key, group] of groups.entries()) {
        if (group.length > 1) {
            const [normEmail, campaign] = key.split('::');
            // Sort oldest first
            group.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            duplicates.push({
                normalizedEmail: normEmail,
                campaign,
                records: group,
                count: group.length,
            });
            totalDuplicates += group.length - 1;
        }
    }
    // Sort duplicates descending by count
    duplicates.sort((a, b) => b.count - a.count);
    return {
        totalRecords: records.length,
        waitlistRecordsCount: waitlistRecords.length,
        uniqueSubscribers: groups.size,
        duplicateGroupsCount: duplicates.length,
        totalRedundantRecords: totalDuplicates,
        topDuplicateEmails: duplicates.slice(0, 15).map((d) => ({
            email: d.normalizedEmail,
            count: d.count,
            campaign: d.campaign,
            firstSubmission: d.records[0].createdAt,
            lastSubmission: d.records[d.records.length - 1].createdAt,
        })),
        dailyDistribution: Object.fromEntries(Array.from(dailyDistribution.entries()).sort(([a], [b]) => a.localeCompare(b))),
        duplicateGroups: duplicates,
    };
}
async function runCli() {
    const args = process.argv.slice(2);
    const isApply = args.includes('--apply');
    const snapshotArgIdx = args.indexOf('--snapshot');
    const snapshotFile = snapshotArgIdx !== -1 ? args[snapshotArgIdx + 1] : null;
    console.log('===========================================================');
    console.log('  WellMindly Waitlist & Newsletter Audit & Deduplication   ');
    console.log('===========================================================');
    console.log(`Mode: ${isApply ? 'APPLY (Modifications WILL be made with backup)' : 'DRY RUN (Audit & report only)'}`);
    let records = [];
    if (snapshotFile) {
        console.log(`Loading records from snapshot file: ${snapshotFile}`);
        const raw = fs_1.default.readFileSync(path_1.default.resolve(process.cwd(), snapshotFile), 'utf-8');
        records = JSON.parse(raw);
    }
    else {
        console.log('Reading records from database table: ContactRequest...');
        try {
            records = await prisma_1.default.contactRequest.findMany({
                orderBy: { createdAt: 'asc' },
            });
        }
        catch (dbErr) {
            console.error('❌ Could not connect to database or read ContactRequest table:', dbErr.message);
            process.exit(1);
        }
    }
    const analysis = analyzeSubscribers(records);
    console.log('\n--- Audit Summary Report ---');
    console.log(`Total ContactRequest Records:     ${analysis.totalRecords}`);
    console.log(`Waitlist/Newsletter Records:     ${analysis.waitlistRecordsCount}`);
    console.log(`Unique Normalized Subscribers:   ${analysis.uniqueSubscribers}`);
    console.log(`Duplicate Email Groups:          ${analysis.duplicateGroupsCount}`);
    console.log(`Redundant Repeat Records:        ${analysis.totalRedundantRecords}`);
    console.log('\n--- Top Duplicate Emails Detected ---');
    for (const item of analysis.topDuplicateEmails) {
        console.log(`  • ${item.email.padEnd(35)} Count: ${String(item.count).padStart(3)} | Earliest: ${new Date(item.firstSubmission).toISOString()} | Latest: ${new Date(item.lastSubmission).toISOString()}`);
    }
    console.log('\n--- Daily Submission Trajectory ---');
    for (const [day, count] of Object.entries(analysis.dailyDistribution)) {
        console.log(`  ${day}: ${'█'.repeat(Math.min(50, Math.ceil(count / 5)))} (${count} submissions)`);
    }
    if (!isApply) {
        console.log('\n===========================================================');
        console.log('To execute safe consolidation and backup on database:');
        console.log('  npx ts-node scripts/audit-and-deduplicate.ts --apply');
        console.log('===========================================================');
        return;
    }
    console.log('\n[APPLY] Starting safe transactional consolidation...');
    // Transactional consolidation via Prisma raw query or migration
    const result = await prisma_1.default.$transaction(async (tx) => {
        // 1. Create archival snapshot
        await tx.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "_archive_contact_requests_backup" AS
      SELECT * FROM "ContactRequest";
    `);
        // 2. Add columns if missing
        await tx.$executeRawUnsafe(`
      ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "normalizedEmail" TEXT;
      ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'VERIFIED';
      ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
      ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verificationTokenHash" TEXT;
      ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "verificationExpiresAt" TIMESTAMP(3);
      ALTER TABLE "ContactRequest" ADD COLUMN IF NOT EXISTS "subscriptionKey" TEXT;
    `);
        // 3. Populate normalized emails
        await tx.$executeRawUnsafe(`
      UPDATE "ContactRequest"
      SET "normalizedEmail" = LOWER(TRIM("email"))
      WHERE "normalizedEmail" IS NULL;
    `);
        // 4. Archive duplicates table
        await tx.$executeRawUnsafe(`
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
        "reason" TEXT NOT NULL DEFAULT 'SCRIPT_DUPLICATE_CONSOLIDATION'
      );
    `);
        // 5. Transfer duplicates to archive
        await tx.$executeRawUnsafe(`
      WITH RankedSubscribers AS (
        SELECT
          "id", "name", "email", "normalizedEmail", "subject", "message", "createdAt",
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
        r."id", r."name", r."email", r."normalizedEmail", r."subject", r."message", r."createdAt",
        r.primary_id, r.total_count, CURRENT_TIMESTAMP, 'SCRIPT_DUPLICATE_CONSOLIDATION'
      FROM RankedSubscribers r
      WHERE r.row_num > 1
      ON CONFLICT ("id") DO NOTHING;
    `);
        // 6. Delete duplicate records from ContactRequest
        const deletedCount = await tx.$executeRawUnsafe(`
      DELETE FROM "ContactRequest"
      WHERE "id" IN (
        SELECT "originalId" FROM "_archive_contact_request_duplicates"
      );
    `);
        // 7. Update subscription keys on retained records
        await tx.$executeRawUnsafe(`
      UPDATE "ContactRequest"
      SET "subscriptionKey" = "normalizedEmail" || '::' || LOWER(TRIM(COALESCE("subject", 'waitlist'))),
          "status" = 'VERIFIED'
      WHERE ("name" IN ('Newsletter Subscriber', 'Newsletter Waitlist')
         OR "subject" ILIKE '%waitlist%'
         OR "subject" ILIKE '%newsletter%')
        AND "subscriptionKey" IS NULL;
    `);
        // 8. Create unique index
        await tx.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ContactRequest_subscriptionKey_key" ON "ContactRequest"("subscriptionKey");
      CREATE INDEX IF NOT EXISTS "ContactRequest_normalizedEmail_idx" ON "ContactRequest"("normalizedEmail");
      CREATE INDEX IF NOT EXISTS "ContactRequest_status_idx" ON "ContactRequest"("status");
    `);
        return deletedCount;
    });
    console.log(`✔ Successfully consolidated duplicates. Archived and removed ${result} duplicate records.`);
    console.log('✔ All unique subscribers retained with original timestamps intact.');
    console.log('✔ Database unique constraint ContactRequest_subscriptionKey_key successfully applied.');
}
if (require.main === module) {
    runCli()
        .catch((err) => {
        console.error('Audit execution error:', err);
        process.exit(1);
    })
        .finally(async () => {
        await prisma_1.default.$disconnect();
    });
}
