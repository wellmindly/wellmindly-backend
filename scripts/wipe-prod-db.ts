import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import 'dotenv/config';

/**
 * CLI script to archive and wipe dummy test data from the production database
 * Run: npx ts-node scripts/wipe-prod-db.ts --confirm
 */
const connectionString = process.env.DATABASE_URL?.split('?')[0];

if (!connectionString) {
  console.error('❌ DATABASE_URL is not defined in environment.');
  process.exit(1);
}

const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

const pool = new Pool({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false }
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function wipeDatabase() {
  const args = process.argv.slice(2);
  if (!args.includes('--confirm')) {
    console.warn(`
⚠️  WARNING: PRODUCTION DATA WIPEOUT REQUESTED ⚠️
Target: ${connectionString.replace(/:\/\/.*@/, '://***@')}

This will permanently delete:
- All student and counselor accounts (role = 'STUDENT' or 'COUNSELOR')
- All counselor profiles, availability, and session bookings
- All session notes, student feedback, and counselor feedback
- All TalkMindly notes, rooms, replies, reactions, and reports
- All daily check-ins, chat messages, and quiz attempt results

This will PRESERVE:
- All ADMIN and SUPER_ADMIN accounts
- All verified Universities & domain configurations
- All static Quizzes and Questions
- All CrisisHotlines

To execute, please re-run with:
npx ts-node scripts/wipe-prod-db.ts --confirm
`);
    process.exit(0);
  }

  console.log('🚀 Starting Prelaunch Database Archival & Wipeout...');

  // 1. Ensure archival table exists
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_archive_prelaunch_backup" (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Archival table `_archive_prelaunch_backup` confirmed.');

  // 2. Fetch snapshot for archival
  const [
    studentsAndCounselors,
    counselorProfiles,
    sessions,
    sessionNotes,
    studentFeedbacks,
    counselorFeedbacks,
    checkins,
    quizResults,
    talkNotes
  ] = await Promise.all([
    prisma.user.findMany({
      where: { role: { in: ['STUDENT', 'COUNSELOR'] } },
      select: { id: true, email: true, firstName: true, lastName: true, role: true, createdAt: true },
    }),
    prisma.counselorProfile.findMany(),
    prisma.counselorSession.findMany(),
    prisma.sessionNote.findMany(),
    prisma.studentFeedback.findMany(),
    prisma.counselorFeedback.findMany(),
    prisma.dailyCheckin.findMany(),
    prisma.quizResult.findMany(),
    prisma.talkNote.findMany(),
  ]);

  const archivePayload = {
    timestamp: new Date().toISOString(),
    studentsAndCounselorsCount: studentsAndCounselors.length,
    counselorProfilesCount: counselorProfiles.length,
    sessionsCount: sessions.length,
    sessionNotesCount: sessionNotes.length,
    feedbacksCount: studentFeedbacks.length + counselorFeedbacks.length,
    checkinsCount: checkins.length,
    quizResultsCount: quizResults.length,
    talkNotesCount: talkNotes.length,
    users: studentsAndCounselors,
    counselorProfiles,
    sessions,
  };

  await prisma.$executeRawUnsafe(
    `INSERT INTO "_archive_prelaunch_backup" (category, data) VALUES ($1, $2::jsonb)`,
    'PRELAUNCH_CLI_WIPE_SNAPSHOT',
    JSON.stringify(archivePayload)
  );
  console.log(`📦 Archived snapshot of ${studentsAndCounselors.length} users, ${sessions.length} sessions to _archive_prelaunch_backup.`);

  // 3. Sequentially wipe test data respecting foreign keys
  console.log('🧹 Wiping session feedback, notes, and bookings...');
  const deletedStudentFeedbacks = await prisma.studentFeedback.deleteMany();
  const deletedCounselorFeedbacks = await prisma.counselorFeedback.deleteMany();
  const deletedSessionNotes = await prisma.sessionNote.deleteMany();
  const deletedSessions = await prisma.counselorSession.deleteMany();
  const deletedExceptions = await prisma.counselorAvailabilityException.deleteMany();
  const deletedAvailabilities = await prisma.counselorAvailability.deleteMany();
  const deletedInvitations = await prisma.counselorInvitation.deleteMany();
  const deletedOnboarding = await prisma.counselorOnboarding.deleteMany();
  const deletedProfiles = await prisma.counselorProfile.deleteMany();

  console.log('🧹 Wiping community talk rooms, chats, checkins, and quiz attempts...');
  const deletedReactions = await prisma.talkReaction.deleteMany();
  const deletedReports = await prisma.talkReport.deleteMany();
  const deletedReplies = await prisma.talkReply.deleteMany();
  const deletedTalkNotes = await prisma.talkNote.deleteMany();
  const deletedTalkRooms = await prisma.talkRoom.deleteMany();
  const deletedChatMessages = await prisma.chatMessage.deleteMany();
  const deletedCheckins = await prisma.dailyCheckin.deleteMany();
  const deletedQuizFeedbacks = await prisma.quizFeedback.deleteMany();
  const deletedQuizResults = await prisma.quizResult.deleteMany();
  const deletedNotifications = await prisma.notification.deleteMany();

  console.log('🧹 Wiping student and counselor user accounts...');
  const deletedUsers = await prisma.user.deleteMany({
    where: { role: { in: ['STUDENT', 'COUNSELOR'] } },
  });

  const remainingAdmins = await prisma.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } });
  const remainingUniversities = await prisma.university.count();
  const remainingQuizzes = await prisma.quiz.count();

  console.log(`
🎉 Production Database Wipe Completed Successfully!
---------------------------------------------------
- Deleted Users (Students & Counselors): ${deletedUsers.count}
- Deleted Counselor Profiles:            ${deletedProfiles.count}
- Deleted Sessions:                      ${deletedSessions.count}
- Deleted Session Notes & Feedbacks:     ${deletedSessionNotes.count + deletedStudentFeedbacks.count + deletedCounselorFeedbacks.count}
- Deleted Community Talk Posts:          ${deletedTalkNotes.count}
- Deleted Daily Check-ins:               ${deletedCheckins.count}
- Deleted Quiz Attempts:                 ${deletedQuizResults.count}
---------------------------------------------------
Preserved System Records:
- Active Admin Users:                    ${remainingAdmins}
- Configured Universities:               ${remainingUniversities}
- Static Assessments:                    ${remainingQuizzes}
---------------------------------------------------
Database is clean and ready for production launch!
`);
}

wipeDatabase()
  .catch((err) => {
    console.error('❌ Wipe failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
