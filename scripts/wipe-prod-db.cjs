/**
 * Standalone Production Database Archival & Wipeout Script
 * 
 * Usage:
 *   node scripts/wipe-prod-db.cjs --confirm
 *
 * Requirements:
 *   DATABASE_URL in environment or passed via command line.
 */
const { Client } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:Wellmindly_2026@wellmindly-db.ctqo2kwcmwch.ap-south-1.rds.amazonaws.com:5432/wellmindly?sslmode=require';

const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

async function run() {
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
  node scripts/wipe-prod-db.cjs --confirm
`);
    process.exit(0);
  }

  const client = new Client({
    connectionString: connectionString.split('?')[0],
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log(`Connecting to database: ${connectionString.replace(/:\/\/.*@/, '://***@')}...`);
    await client.connect();
    console.log('Connected successfully!');

    console.log('Beginning transaction...');
    await client.query('BEGIN');

    // 1. Create archival backup table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_archive_prelaunch_backup" (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Snapshot dummy users
    console.log('Archiving snapshot of students and counselors...');
    const snapshotRes = await client.query(`
      INSERT INTO "_archive_prelaunch_backup" (category, data)
      SELECT 'PRELAUNCH_SNAPSHOT', json_build_object(
        'users', (SELECT json_agg(row_to_json(u)) FROM (SELECT id, email, "firstName", "lastName", role, "createdAt" FROM "User" WHERE role IN ('STUDENT', 'COUNSELOR')) u),
        'counselorProfiles', (SELECT json_agg(row_to_json(cp)) FROM "CounselorProfile" cp),
        'sessions', (SELECT json_agg(row_to_json(cs)) FROM "CounselorSession" cs),
        'checkinsCount', (SELECT count(*) FROM "DailyCheckin"),
        'quizResultsCount', (SELECT count(*) FROM "QuizResult"),
        'talkNotesCount', (SELECT count(*) FROM "TalkNote")
      )
      RETURNING id;
    `);
    console.log(`Archive snapshot recorded with ID: ${snapshotRes.rows[0]?.id}`);

    // 3. Delete dependent rows respecting foreign keys
    console.log('Deleting dependent data...');
    const delFeedbacks = await client.query('DELETE FROM "StudentFeedback"');
    const delCounselorFeedbacks = await client.query('DELETE FROM "CounselorFeedback"');
    const delSessionNotes = await client.query('DELETE FROM "SessionNote"');
    const delSessions = await client.query('DELETE FROM "CounselorSession"');
    const delExceptions = await client.query('DELETE FROM "CounselorAvailabilityException"');
    const delAvailabilities = await client.query('DELETE FROM "CounselorAvailability"');
    const delInvitations = await client.query('DELETE FROM "CounselorInvitation"');
    const delOnboardings = await client.query('DELETE FROM "CounselorOnboarding"');
    const delProfiles = await client.query('DELETE FROM "CounselorProfile"');

    const delReactions = await client.query('DELETE FROM "TalkReaction"');
    const delReports = await client.query('DELETE FROM "TalkReport"');
    const delReplies = await client.query('DELETE FROM "TalkReply"');
    const delTalkNotes = await client.query('DELETE FROM "TalkNote"');
    const delTalkRooms = await client.query('DELETE FROM "TalkRoom"');
    const delChatMessages = await client.query('DELETE FROM "ChatMessage"');
    const delCheckins = await client.query('DELETE FROM "DailyCheckin"');
    const delQuizFeedback = await client.query('DELETE FROM "QuizFeedback"');
    const delQuizResults = await client.query('DELETE FROM "QuizResult"');
    const delNotifications = await client.query('DELETE FROM "Notification"');

    // 4. Delete dummy users
    console.log('Deleting dummy students and counselors...');
    const delUsers = await client.query(`DELETE FROM "User" WHERE role IN ('STUDENT', 'COUNSELOR')`);

    await client.query('COMMIT');
    console.log('Transaction committed successfully!\n');

    // 5. Verification summary
    const adminCount = await client.query(`SELECT count(*) FROM "User" WHERE role IN ('ADMIN', 'SUPER_ADMIN')`);
    const uniCount = await client.query('SELECT count(*) FROM "University"');
    const quizCount = await client.query('SELECT count(*) FROM "Quiz"');
    const hotlineCount = await client.query('SELECT count(*) FROM "CrisisHotline"');

    console.log('=== WIPEOUT COMPLETE ===');
    console.log(`Deleted Users (STUDENT/COUNSELOR) : ${delUsers.rowCount}`);
    console.log(`Deleted Counselor Profiles        : ${delProfiles.rowCount}`);
    console.log(`Deleted Sessions                  : ${delSessions.rowCount}`);
    console.log(`Deleted Check-ins                 : ${delCheckins.rowCount}`);
    console.log(`Deleted Quiz Results              : ${delQuizResults.rowCount}`);
    console.log(`Deleted Talk Notes                : ${delTalkNotes.rowCount}`);
    console.log(`----------------------------------------`);
    console.log(`Preserved Administrators          : ${adminCount.rows[0].count}`);
    console.log(`Preserved Universities            : ${uniCount.rows[0].count}`);
    console.log(`Preserved Quizzes                 : ${quizCount.rows[0].count}`);
    console.log(`Preserved Crisis Hotlines         : ${hotlineCount.rows[0].count}`);
    console.log('========================');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Wipe failed with error:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

run();
