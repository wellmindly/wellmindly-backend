import fs from 'fs';
import path from 'path';
import readline from 'readline';
import prisma from '../src/lib/prisma';
import { classifySubscriber } from '../src/utils/subscriberClassifier';
import { normalizeEmail } from '../src/middleware/waitlistProtection';

interface CSVRow {
  id: string;
  email: string;
  category: string;
  note: string;
  date: string;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseDateSafely(dateStr: string): Date {
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  return new Date();
}

export async function processSnapshotAndClassify(csvPath: string, applyChanges: boolean = false) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found at path: ${csvPath}`);
  }

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let isHeader = true;
  const rawRows: CSVRow[] = [];
  const emailCounts = new Map<string, number>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const cols = parseCSVLine(line);
    if (cols.length >= 5) {
      const email = cols[1].trim();
      const normalized = normalizeEmail(email);
      rawRows.push({
        id: cols[0].trim(),
        email,
        category: cols[2].trim() || 'Waitlist: Human Counselling for All Students',
        note: cols[3].trim() || 'Requested newsletter notification when human coaching opens up to all students.',
        date: cols[4].trim(),
      });
      emailCounts.set(normalized, (emailCounts.get(normalized) || 0) + 1);
    }
  }

  console.log(`\n========================================================`);
  console.log(`  WellMindly Subscriber Classification & Restoration`);
  console.log(`========================================================`);
  console.log(`Total Records Loaded: ${rawRows.length}`);
  console.log(`Total Unique Normalized Emails: ${emailCounts.size}`);

  // Classify each unique email
  const classificationMap = new Map<string, ReturnType<typeof classifySubscriber>>();
  for (const [email, count] of emailCounts.entries()) {
    classificationMap.set(email, classifySubscriber(email, count));
  }

  // Partition raw records into Fake (for archive) and Real (to retain)
  const fakeRecordsToArchive: Array<{
    originalId: string;
    email: string;
    normalizedEmail: string;
    name: string;
    subject: string;
    message: string;
    classificationReasons: string;
    botScore: number;
    originalCreatedAt: Date;
  }> = [];

  // For real records: group by normalized email to keep the earliest submitted record (deduplication)
  const realRecordsByEmail = new Map<string, CSVRow[]>();

  for (const row of rawRows) {
    const normalized = normalizeEmail(row.email);
    const classification = classificationMap.get(normalized);

    if (classification && classification.isFake) {
      fakeRecordsToArchive.push({
        originalId: row.id,
        email: row.email,
        normalizedEmail: normalized,
        name: 'Newsletter Subscriber',
        subject: row.category,
        message: row.note,
        classificationReasons: classification.reasons.join('; '),
        botScore: classification.score,
        originalCreatedAt: parseDateSafely(row.date),
      });
    } else {
      if (!realRecordsByEmail.has(normalized)) {
        realRecordsByEmail.set(normalized, []);
      }
      realRecordsByEmail.get(normalized)!.push(row);
    }
  }

  const uniqueRealSubscribers: Array<{
    id: string;
    name: string;
    email: string;
    normalizedEmail: string;
    subject: string;
    message: string;
    status: string;
    subscriptionKey: string;
    createdAt: Date;
    verifiedAt: Date;
  }> = [];

  const realDuplicateRecordsToArchive: Array<{
    originalId: string;
    email: string;
    normalizedEmail: string;
    name: string;
    subject: string;
    message: string;
    classificationReasons: string;
    botScore: number;
    originalCreatedAt: Date;
  }> = [];

  for (const [normalized, records] of realRecordsByEmail.entries()) {
    // Sort chronologically (earliest first)
    records.sort((a, b) => parseDateSafely(a.date).getTime() - parseDateSafely(b.date).getTime());
    const primary = records[0];

    const campaign = primary.category || 'Waitlist: Human Counselling for All Students';
    const subKey = `${normalized}::${campaign.trim().toLowerCase()}`;
    const primaryDate = parseDateSafely(primary.date);

    uniqueRealSubscribers.push({
      id: primary.id,
      name: 'Newsletter Subscriber',
      email: primary.email,
      normalizedEmail: normalized,
      subject: campaign,
      message: primary.note,
      status: 'VERIFIED',
      subscriptionKey: subKey,
      createdAt: primaryDate,
      verifiedAt: primaryDate,
    });

    // If there were duplicates of this real subscriber, archive the subsequent duplicate attempts
    for (let i = 1; i < records.length; i++) {
      const dup = records[i];
      realDuplicateRecordsToArchive.push({
        originalId: dup.id,
        email: dup.email,
        normalizedEmail: normalized,
        name: 'Newsletter Subscriber',
        subject: dup.category,
        message: dup.note,
        classificationReasons: `Duplicate submission of verified real subscriber (${records.length} attempts total)`,
        botScore: 0,
        originalCreatedAt: parseDateSafely(dup.date),
      });
    }
  }

  console.log(`\nClassification Results:`);
  console.log(`- Real Unique Subscribers To Keep/Restore: ${uniqueRealSubscribers.length}`);
  console.log(`- Duplicate Real Records Consolidated: ${realDuplicateRecordsToArchive.length}`);
  console.log(`- Fake / Bot Records To Archive: ${fakeRecordsToArchive.length}`);
  console.log(
    `- Verification Check: ${uniqueRealSubscribers.length} (Real primary) + ${realDuplicateRecordsToArchive.length} (Real dups) + ${fakeRecordsToArchive.length} (Fake) = ${
      uniqueRealSubscribers.length + realDuplicateRecordsToArchive.length + fakeRecordsToArchive.length
    } total records.`
  );

  // Generate audit CSVs
  const reportDir = path.resolve(__dirname, '../../reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const realExportPath = path.join(reportDir, 'real_subscribers_to_keep.csv');
  const fakeExportPath = path.join(reportDir, 'fake_subscribers_archived.csv');

  const realCSV = [
    'Subscriber ID,Email,Normalized Email,Campaign,Submission Date,Status,Subscription Key',
    ...uniqueRealSubscribers.map(
      (s) => `"${s.id}","${s.email}","${s.normalizedEmail}","${s.subject}","${s.createdAt.toISOString()}","${s.status}","${s.subscriptionKey}"`
    ),
  ].join('\n');
  fs.writeFileSync(realExportPath, realCSV, 'utf8');

  const allArchived = [...fakeRecordsToArchive, ...realDuplicateRecordsToArchive];
  const fakeCSV = [
    'Original ID,Email,Normalized Email,Bot Score,Classification Reasons,Submission Date',
    ...allArchived.map(
      (f) => `"${f.originalId}","${f.email}","${f.normalizedEmail}",${f.botScore},"${f.classificationReasons}","${f.originalCreatedAt.toISOString()}"`
    ),
  ].join('\n');
  fs.writeFileSync(fakeExportPath, fakeCSV, 'utf8');

  console.log(`\nAudit Reports Written:`);
  console.log(`- Real Subscribers: ${realExportPath}`);
  console.log(`- Archived Fake & Consolidated: ${fakeExportPath}`);

  if (!applyChanges) {
    console.log(`\n[DRY RUN COMPLETE] No changes were written to the database.`);
    console.log(`Run with --apply to write changes to PostgreSQL.`);
    return {
      total: rawRows.length,
      realUnique: uniqueRealSubscribers.length,
      realDuplicates: realDuplicateRecordsToArchive.length,
      fakeArchived: fakeRecordsToArchive.length,
      applied: false,
    };
  }

  console.log(`\nApplying changes to database...`);

  // Write fake records to ArchivedFakeContactRequest
  let fakeInserted = 0;
  for (const f of allArchived) {
    try {
      await prisma.archivedFakeContactRequest.create({
        data: {
          originalId: f.originalId,
          name: f.name,
          email: f.email,
          normalizedEmail: f.normalizedEmail,
          subject: f.subject,
          message: f.message,
          classificationReasons: f.classificationReasons,
          botScore: f.botScore,
          originalCreatedAt: f.originalCreatedAt,
        },
      });
      fakeInserted++;
    } catch (e: any) {
      // If table doesn't exist yet, we catch or continue
      console.warn(`Could not insert archived fake record:`, e.message);
    }
  }

  // Restore/Insert Real unique subscribers into ContactRequest
  let realInserted = 0;
  let realUpdated = 0;

  for (const s of uniqueRealSubscribers) {
    try {
      await prisma.contactRequest.upsert({
        where: { subscriptionKey: s.subscriptionKey },
        create: {
          id: s.id,
          name: s.name,
          email: s.email,
          normalizedEmail: s.normalizedEmail,
          subject: s.subject,
          message: s.message,
          status: s.status,
          subscriptionKey: s.subscriptionKey,
          createdAt: s.createdAt,
          verifiedAt: s.verifiedAt,
        },
        update: {
          status: 'VERIFIED',
          verifiedAt: s.verifiedAt,
        },
      });
      realInserted++;
    } catch (e: any) {
      console.warn(`Error restoring real subscriber ${s.email}:`, e.message);
    }
  }

  console.log(`\n[APPLY COMPLETE]`);
  console.log(`- Archived fake & duplicate records saved: ${fakeInserted}`);
  console.log(`- Real unique subscribers active in ContactRequest: ${realInserted}`);

  return {
    total: rawRows.length,
    realUnique: uniqueRealSubscribers.length,
    realDuplicates: realDuplicateRecordsToArchive.length,
    fakeArchived: fakeRecordsToArchive.length,
    applied: true,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const defaultPath = 'C:\\Users\\malan\\Downloads\\wellmindly-newsletter-subscribers.csv';
  const csvArg = args.find((a) => !a.startsWith('--')) || defaultPath;

  processSnapshotAndClassify(csvArg, apply)
    .catch((err) => {
      console.error('Fatal error during classification:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
