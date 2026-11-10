-- Baseline for schema objects that exist in schema.prisma (and, via
-- `prisma db push`, in deployed databases) but were never captured in a
-- migration: the counselor booking system, audit log, notifications, the
-- TalkMindly profile columns on "User", soft-delete/timezone columns and two
-- Role values.
--
-- Every statement is idempotent (IF NOT EXISTS / duplicate guards), so this is
-- safe to run with `prisma migrate deploy` on a fresh database AND on a
-- database that already has these objects from `db push`. It deliberately
-- omits the DROP TABLE of the _archive_* backup tables and the
-- "updatedAt" DROP DEFAULT changes that a raw `migrate diff` would add.
--
-- Added 2026-11-09 by the pre-launch QA sweep. NOT applied anywhere.

DO $$ BEGIN
  CREATE TYPE "CounselorStatus" AS ENUM ('INVITED', 'PROFILE_PENDING', 'UNDER_REVIEW', 'ACTIVE', 'SUSPENDED', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "SessionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_STUDENT', 'CANCELLED_BY_COUNSELOR', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'COUNSELOR';

ALTER TABLE "TalkNote" ADD COLUMN IF NOT EXISTS     "moderationReason" TEXT;

ALTER TABLE "TalkReply" ADD COLUMN IF NOT EXISTS     "moderationReason" TEXT;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS     "deletedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "talkAvatar" TEXT,
ADD COLUMN IF NOT EXISTS     "talkBio" TEXT,
ADD COLUMN IF NOT EXISTS     "talkNickname" TEXT,
ADD COLUMN IF NOT EXISTS     "talkTermsAccepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "timezone" TEXT NOT NULL DEFAULT 'UTC';

CREATE TABLE IF NOT EXISTS "CounselorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "specializations" TEXT[],
    "credentials" TEXT NOT NULL,
    "bio" TEXT,
    "avatarUrl" TEXT,
    "phone" TEXT,
    "status" "CounselorStatus" NOT NULL DEFAULT 'INVITED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CounselorProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CounselorAvailability" (
    "id" TEXT NOT NULL,
    "counselorId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "slotDurationMins" INTEGER NOT NULL DEFAULT 45,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounselorAvailability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CounselorAvailabilityException" (
    "id" TEXT NOT NULL,
    "counselorId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isFullDay" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounselorAvailabilityException_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CounselorSession" (
    "id" TEXT NOT NULL,
    "counselorId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'CONFIRMED',
    "meetingLink" TEXT NOT NULL,
    "cancellationReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CounselorSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SessionNote" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "counselorId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StudentFeedback" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "counselorId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comments" TEXT,
    "answers" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentFeedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CounselorFeedback" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "counselorId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "summaryNote" TEXT NOT NULL,
    "answers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounselorFeedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CounselorInvitation" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounselorInvitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetEntity" TEXT NOT NULL,
    "targetId" TEXT,
    "ipAddress" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CounselorProfile_userId_key" ON "CounselorProfile"("userId");

CREATE INDEX IF NOT EXISTS "CounselorProfile_status_idx" ON "CounselorProfile"("status");

CREATE INDEX IF NOT EXISTS "CounselorAvailability_counselorId_dayOfWeek_idx" ON "CounselorAvailability"("counselorId", "dayOfWeek");

CREATE INDEX IF NOT EXISTS "CounselorAvailabilityException_counselorId_startDate_endDat_idx" ON "CounselorAvailabilityException"("counselorId", "startDate", "endDate");

CREATE INDEX IF NOT EXISTS "CounselorSession_counselorId_startTime_idx" ON "CounselorSession"("counselorId", "startTime");

CREATE INDEX IF NOT EXISTS "CounselorSession_studentId_startTime_idx" ON "CounselorSession"("studentId", "startTime");

CREATE INDEX IF NOT EXISTS "CounselorSession_status_idx" ON "CounselorSession"("status");

CREATE INDEX IF NOT EXISTS "SessionNote_sessionId_idx" ON "SessionNote"("sessionId");

CREATE INDEX IF NOT EXISTS "SessionNote_counselorId_studentId_idx" ON "SessionNote"("counselorId", "studentId");

CREATE UNIQUE INDEX IF NOT EXISTS "StudentFeedback_sessionId_key" ON "StudentFeedback"("sessionId");

CREATE INDEX IF NOT EXISTS "StudentFeedback_counselorId_rating_idx" ON "StudentFeedback"("counselorId", "rating");

CREATE UNIQUE INDEX IF NOT EXISTS "CounselorFeedback_sessionId_key" ON "CounselorFeedback"("sessionId");

CREATE INDEX IF NOT EXISTS "CounselorFeedback_counselorId_idx" ON "CounselorFeedback"("counselorId");

CREATE UNIQUE INDEX IF NOT EXISTS "CounselorInvitation_email_key" ON "CounselorInvitation"("email");

CREATE UNIQUE INDEX IF NOT EXISTS "CounselorInvitation_token_key" ON "CounselorInvitation"("token");

CREATE INDEX IF NOT EXISTS "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

CREATE INDEX IF NOT EXISTS "Notification_userId_read_idx" ON "Notification"("userId", "read");

CREATE UNIQUE INDEX IF NOT EXISTS "User_talkNickname_key" ON "User"("talkNickname");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CounselorProfile_userId_fkey') THEN
    ALTER TABLE "CounselorProfile" ADD CONSTRAINT "CounselorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CounselorAvailability_counselorId_fkey') THEN
    ALTER TABLE "CounselorAvailability" ADD CONSTRAINT "CounselorAvailability_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "CounselorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CounselorAvailabilityException_counselorId_fkey') THEN
    ALTER TABLE "CounselorAvailabilityException" ADD CONSTRAINT "CounselorAvailabilityException_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "CounselorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CounselorSession_counselorId_fkey') THEN
    ALTER TABLE "CounselorSession" ADD CONSTRAINT "CounselorSession_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "CounselorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CounselorSession_studentId_fkey') THEN
    ALTER TABLE "CounselorSession" ADD CONSTRAINT "CounselorSession_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SessionNote_sessionId_fkey') THEN
    ALTER TABLE "SessionNote" ADD CONSTRAINT "SessionNote_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CounselorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SessionNote_counselorId_fkey') THEN
    ALTER TABLE "SessionNote" ADD CONSTRAINT "SessionNote_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "CounselorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StudentFeedback_sessionId_fkey') THEN
    ALTER TABLE "StudentFeedback" ADD CONSTRAINT "StudentFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CounselorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StudentFeedback_counselorId_fkey') THEN
    ALTER TABLE "StudentFeedback" ADD CONSTRAINT "StudentFeedback_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "CounselorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CounselorFeedback_sessionId_fkey') THEN
    ALTER TABLE "CounselorFeedback" ADD CONSTRAINT "CounselorFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CounselorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CounselorFeedback_counselorId_fkey') THEN
    ALTER TABLE "CounselorFeedback" ADD CONSTRAINT "CounselorFeedback_counselorId_fkey" FOREIGN KEY ("counselorId") REFERENCES "CounselorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AuditLog_actorId_fkey') THEN
    ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Notification_userId_fkey') THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
