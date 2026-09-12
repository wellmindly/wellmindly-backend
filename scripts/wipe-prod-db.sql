-- WellMindly Prelaunch Database Wipeout & Archive Script
-- Preserves ADMIN/SUPER_ADMIN users, Universities, Quizzes, and Hotlines.
-- Run in psql, pgAdmin, or AWS RDS Query Editor.

BEGIN;

-- 1. Create archival backup table
CREATE TABLE IF NOT EXISTS "_archive_prelaunch_backup" (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Snapshot dummy users and counselor profiles into archive
INSERT INTO "_archive_prelaunch_backup" (category, data)
SELECT 'PRELAUNCH_SNAPSHOT', json_build_object(
  'timestamp', NOW(),
  'users', (SELECT json_agg(row_to_json(u)) FROM (SELECT id, email, "firstName", "lastName", role, "createdAt" FROM "User" WHERE role IN ('STUDENT', 'COUNSELOR')) u),
  'counselorProfiles', (SELECT json_agg(row_to_json(cp)) FROM "CounselorProfile" cp),
  'sessions', (SELECT json_agg(row_to_json(cs)) FROM "CounselorSession" cs),
  'checkinsCount', (SELECT count(*) FROM "DailyCheckin"),
  'quizResultsCount', (SELECT count(*) FROM "QuizResult"),
  'talkNotesCount', (SELECT count(*) FROM "TalkNote")
);

-- 3. Sequentially wipe test data respecting foreign keys
DELETE FROM "StudentFeedback";
DELETE FROM "CounselorFeedback";
DELETE FROM "SessionNote";
DELETE FROM "CounselorSession";
DELETE FROM "CounselorAvailabilityException";
DELETE FROM "CounselorAvailability";
DELETE FROM "CounselorInvitation";
DELETE FROM "CounselorOnboarding";
DELETE FROM "CounselorProfile";

DELETE FROM "TalkReaction";
DELETE FROM "TalkReport";
DELETE FROM "TalkReply";
DELETE FROM "TalkNote";
DELETE FROM "TalkRoom";
DELETE FROM "ChatMessage";
DELETE FROM "DailyCheckin";
DELETE FROM "QuizFeedback";
DELETE FROM "QuizResult";
DELETE FROM "Notification";

-- 4. Delete dummy students & counselors (safely preserving ADMIN and SUPER_ADMIN!)
DELETE FROM "User" WHERE role IN ('STUDENT', 'COUNSELOR');

COMMIT;

-- Verification Queries
SELECT 'Preserved Admins' as item, count(*) as count FROM "User" WHERE role IN ('ADMIN', 'SUPER_ADMIN')
UNION ALL
SELECT 'Preserved Universities', count(*) FROM "University"
UNION ALL
SELECT 'Preserved Quizzes', count(*) FROM "Quiz"
UNION ALL
SELECT 'Preserved Crisis Hotlines', count(*) FROM "CrisisHotline"
UNION ALL
SELECT 'Remaining Students/Counselors (should be 0)', count(*) FROM "User" WHERE role IN ('STUDENT', 'COUNSELOR');
