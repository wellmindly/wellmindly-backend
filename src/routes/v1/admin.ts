import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { authenticateJWT, requireRoles, AuthenticatedRequest } from '../../middleware/rbac';
import { verifyToken } from '../../lib/jwt';
import { sendSuccess, sendError } from '../../utils/response';
import { sendEmail } from '../../utils/mailer';
import { queueEmail } from '../../utils/emailQueue';
import { logAuditEvent } from '../../utils/auditLogger';
import { escapeHtml } from '../../utils/escapeHtml';
import { env } from '../../config/env';
import { normalizeAvatarUrl } from './counselors';
import {
  closeInvitationFor,
  findActivatedCounselorEmails,
  issueCounselorInvitation,
  normalizeEmail,
  REQUESTED_DOCS,
  sendDocsRequestEmail,
} from '../../services/counselorPipeline';

const router = Router();

/**
 * POST /api/v1/admin/maintenance/wipe-prod-data
 * Archives and wipes dummy/test data (students, counselors, sessions, check-ins, talk rooms/notes)
 * while safely preserving admin accounts, universities, quizzes, and hotlines.
 * Accessible with x-maintenance-key header OR authenticated admin JWT.
 */
router.post('/maintenance/wipe-prod-data', async (req: Request, res: Response) => {
  try {
    const maintenanceKey = req.headers['x-maintenance-key'];
    const expectedKey = env.MAINTENANCE_KEY;
    let isAuthorized = false;
    let actorId: string | null = null;

    const keyMatches =
      typeof maintenanceKey === 'string' &&
      !!expectedKey &&
      expectedKey.length >= 32 &&
      maintenanceKey.length === expectedKey.length &&
      crypto.timingSafeEqual(Buffer.from(maintenanceKey), Buffer.from(expectedKey));

    if (keyMatches) {
      isAuthorized = true;
      actorId = 'MAINTENANCE_KEY';
    } else {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const payload = verifyToken(authHeader.split(' ')[1]);
          if (['ADMIN', 'SUPER_ADMIN'].includes(payload.role)) {
            isAuthorized = true;
            actorId = payload.sub;
          }
        } catch (_) {}
      }
    }

    if (!isAuthorized) {
      sendError(res, 'UNAUTHORIZED', 'Missing or invalid maintenance key (x-maintenance-key header) or admin Bearer token', 401);
      return;
    }

    const { confirm } = req.body as { confirm?: string };

    if (confirm !== 'CONFIRM_WIPE_PROD_DATA') {
      sendError(
        res,
        'CONFIRMATION_REQUIRED',
        'Confirmation keyword mismatch. Please pass { "confirm": "CONFIRM_WIPE_PROD_DATA" } in the request body to execute the wipe.',
        400
      );
      return;
    }

    // 1. Ensure archival table exists
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "_archive_prelaunch_backup" (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 2. Snapshot dummy users and counselor profiles into archive
    await prisma.$executeRawUnsafe(`
      INSERT INTO "_archive_prelaunch_backup" (category, data)
      SELECT 'PRELAUNCH_SNAPSHOT', json_build_object(
        'timestamp', NOW(),
        'users', (SELECT json_agg(row_to_json(u)) FROM (SELECT id, email, "firstName", "lastName", role, "createdAt" FROM "User" WHERE role IN ('STUDENT', 'COUNSELOR')) u)
      );
    `);

    // 3. Sequentially wipe test data respecting foreign keys using IF EXISTS guards
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'StudentFeedback') THEN
          DELETE FROM "StudentFeedback";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CounselorFeedback') THEN
          DELETE FROM "CounselorFeedback";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'SessionNote') THEN
          DELETE FROM "SessionNote";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CounselorSession') THEN
          DELETE FROM "CounselorSession";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CounselorAvailabilityException') THEN
          DELETE FROM "CounselorAvailabilityException";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CounselorAvailability') THEN
          DELETE FROM "CounselorAvailability";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CounselorInvitation') THEN
          DELETE FROM "CounselorInvitation";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CounselorOnboarding') THEN
          DELETE FROM "CounselorOnboarding";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'CounselorProfile') THEN
          DELETE FROM "CounselorProfile";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'TalkReaction') THEN
          DELETE FROM "TalkReaction";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'TalkReport') THEN
          DELETE FROM "TalkReport";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'TalkReply') THEN
          DELETE FROM "TalkReply";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'TalkNote') THEN
          DELETE FROM "TalkNote";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'TalkRoom') THEN
          DELETE FROM "TalkRoom";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'ChatMessage') THEN
          DELETE FROM "ChatMessage";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'DailyCheckin') THEN
          DELETE FROM "DailyCheckin";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'QuizFeedback') THEN
          DELETE FROM "QuizFeedback";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'QuizResult') THEN
          DELETE FROM "QuizResult";
        END IF;
        IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'Notification') THEN
          DELETE FROM "Notification";
        END IF;
        DELETE FROM "User" WHERE role IN ('STUDENT', 'COUNSELOR');
      END $$;
    `);

    const preservedAdmins = await prisma.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } }).catch(() => 0);
    const preservedUniversities = await prisma.university.count().catch(() => 0);
    const preservedQuizzes = await prisma.quiz.count().catch(() => 0);
    const remainingTestUsers = await prisma.user.count({ where: { role: { in: ['STUDENT', 'COUNSELOR'] } } }).catch(() => 0);

    sendSuccess(res, {
      message: 'Production dummy data wiped and archived successfully',
      summary: {
        remainingTestUsers,
        preservedAdmins,
        preservedUniversities,
        preservedQuizzes,
      },
    });
  } catch (error: any) {
    console.error('❌ Failed to wipe prod data:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'WIPE_EXECUTION_ERROR',
        message: error?.message || String(error),
      },
    });
  }
});

// Protect all other admin routes with JWT and ADMIN/SUPER_ADMIN roles
router.use(authenticateJWT, requireRoles(['ADMIN', 'SUPER_ADMIN']));

/**
 * POST /api/v1/admin/counselors/invite
 * Create or refresh an invitation for a counselor and send setup email.
 * The invitee is listed under Counselor Applications until they activate.
 */
router.post('/counselors/invite', async (req: AuthenticatedRequest, res: Response) => {
  const { email, firstName, lastName } = req.body as {
    email?: string;
    firstName?: string;
    lastName?: string;
  };

  if (
    typeof email !== 'string' || typeof firstName !== 'string' || typeof lastName !== 'string' ||
    !email.trim() || !firstName.trim() || !lastName.trim()
  ) {
    sendError(res, 'INVALID_INPUT', 'Email, firstName, and lastName are required', 400);
    return;
  }

  const cleanEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    sendError(res, 'INVALID_INPUT', 'Enter a valid email address', 400);
    return;
  }

  // Check if a registered user already exists with this email
  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: cleanEmail, mode: 'insensitive' } },
    include: { counselorProfile: { select: { id: true } } },
  });
  if (existingUser) {
    if (existingUser.role === 'COUNSELOR' && existingUser.counselorProfile) {
      await closeInvitationFor(cleanEmail);
      sendError(res, 'ALREADY_ACTIVATED', `${cleanEmail} has already activated a counselor account and is listed in the Counselor Directory.`, 409);
      return;
    }
    sendError(res, 'USER_EXISTS', `A registered ${existingUser.role.toLowerCase()} account with email '${cleanEmail}' already exists.`, 409);
    return;
  }

  const { invitation, setupUrl, emailDelivered } = await issueCounselorInvitation(req, {
    email: cleanEmail,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
  });

  logAuditEvent({
    actorId: req.user?.sub,
    action: 'INVITE_COUNSELOR',
    targetEntity: 'CounselorInvitation',
    targetId: invitation.id,
    ipAddress: req.ip || null,
    details: { email: cleanEmail, firstName, lastName, emailDelivered },
  });

  sendSuccess(
    res,
    {
      message: emailDelivered
        ? 'Invitation sent successfully'
        : 'Invitation created, but the email could not be sent. Share the setup link with the counselor directly.',
      emailDelivered,
      setupUrl,
      invitation: { id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt },
    },
    201
  );
});

/** Loads an invitation that is still pending (not used, invitee not activated). */
async function loadPendingInvitation(id: string, res: Response) {
  const invitation = await prisma.counselorInvitation.findUnique({ where: { id } });
  if (!invitation) {
    sendError(res, 'NOT_FOUND', 'Invitation not found. It may have been revoked; refresh the list.', 404);
    return null;
  }
  const activated = await findActivatedCounselorEmails([invitation.email]);
  if (invitation.used || activated.size > 0) {
    if (!invitation.used) await closeInvitationFor(invitation.email);
    sendError(res, 'ALREADY_ACTIVATED', `${invitation.email} has already activated their counselor account.`, 409);
    return null;
  }
  return invitation;
}

/**
 * POST /api/v1/admin/counselors/invitations/:id/resend
 * Refresh the token/expiry of a pending invitation and email the setup link again.
 */
router.post('/counselors/invitations/:id/resend', async (req: AuthenticatedRequest, res: Response) => {
  const invitation = await loadPendingInvitation(String(req.params.id), res);
  if (!invitation) return;

  const result = await issueCounselorInvitation(req, {
    email: invitation.email,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
  });

  logAuditEvent({
    actorId: req.user?.sub,
    action: 'INVITE_COUNSELOR',
    targetEntity: 'CounselorInvitation',
    targetId: invitation.id,
    ipAddress: req.ip || null,
    details: { email: invitation.email, resend: true, emailDelivered: result.emailDelivered },
  });

  sendSuccess(res, {
    message: result.emailDelivered
      ? `Invitation re-sent to ${invitation.email}`
      : `Invitation refreshed, but the email to ${invitation.email} could not be sent. Share the setup link directly.`,
    emailDelivered: result.emailDelivered,
    setupUrl: result.setupUrl,
    invitation: { id: result.invitation.id, email: result.invitation.email, expiresAt: result.invitation.expiresAt },
  });
});

/**
 * POST /api/v1/admin/counselors/invitations/:id/request-docs
 * Ask a directly-invited counselor for their degree / ID / license documents.
 */
router.post('/counselors/invitations/:id/request-docs', async (req: AuthenticatedRequest, res: Response) => {
  const invitation = await loadPendingInvitation(String(req.params.id), res);
  if (!invitation) return;

  const emailDelivered = await sendDocsRequestEmail({
    to: invitation.email,
    name: `${invitation.firstName} ${invitation.lastName}`.trim(),
  });

  await prisma.auditLog.create({
    data: {
      action: 'COUNSELOR_DOCS_REQUESTED',
      targetEntity: 'CounselorInvitation',
      targetId: invitation.id,
      actorId: req.user?.sub || null,
      details: {
        requestedBy: req.user?.email || 'admin',
        requestedDocs: REQUESTED_DOCS,
        emailDelivered,
        timestamp: new Date().toISOString(),
      },
    },
  });

  sendSuccess(res, {
    emailDelivered,
    message: emailDelivered
      ? `Document & certificate request email sent to ${invitation.email}`
      : `Document request recorded, but the email to ${invitation.email} could not be sent. Contact them directly.`,
  });
});

/**
 * DELETE /api/v1/admin/counselors/invitations/:id
 * Revoke a pending invitation (its setup link stops working immediately).
 */
router.delete('/counselors/invitations/:id', async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  const invitation = await prisma.counselorInvitation.findUnique({ where: { id } });
  if (!invitation) {
    sendError(res, 'NOT_FOUND', 'Invitation not found. It may already have been revoked.', 404);
    return;
  }
  if (invitation.used) {
    sendError(res, 'ALREADY_ACTIVATED', 'This invitation has already been used to activate an account.', 409);
    return;
  }

  await prisma.counselorInvitation.delete({ where: { id } });

  logAuditEvent({
    actorId: req.user?.sub,
    action: 'REVOKE_COUNSELOR_INVITE',
    targetEntity: 'CounselorInvitation',
    targetId: id,
    ipAddress: req.ip || null,
    details: { email: invitation.email },
  });

  sendSuccess(res, { message: `Invitation for ${invitation.email} revoked.` });
});

/**
 * GET /api/v1/admin/counselors
 * List all counselors with pagination & status filters
 */
router.get('/counselors', async (req: AuthenticatedRequest, res: Response) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const status = req.query.status as string;

  // Directory = counselors who have activated: a CounselorProfile only exists once the
  // invitee completed /v1/counselors/setup-profile (or an existing counselor account was
  // approved). Pending invitations are listed under Counselor Applications instead.
  const where: any = { deletedAt: null, user: { role: 'COUNSELOR', deletedAt: null } };
  if (status) where.status = status;

  const [total, counselors] = await Promise.all([
    prisma.counselorProfile.count({ where }),
    prisma.counselorProfile.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            timezone: true,
          },
        },
        _count: {
          select: {
            sessions: true,
            receivedFeedback: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const formattedCounselors = counselors.map((c) => ({
    ...c,
    avatarUrl: normalizeAvatarUrl(c.avatarUrl),
  }));

  sendSuccess(res, formattedCounselors, 200, { page, limit, total, totalPages: Math.ceil(total / limit) });
});

/**
 * PUT /api/v1/admin/counselors/:id/status
 * Change counselor status (e.g., UNDER_REVIEW -> ACTIVE or SUSPENDED)
 */
router.put('/counselors/:id/status', async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  const { status } = req.body as { status?: string };

  // Without this the value goes to Prisma as `any`, an unknown status comes back
  // as a 500, and the admin UI shows "something went wrong" for what is really a
  // bad request.
  const allowedStatuses = [
    'INVITED',
    'PROFILE_PENDING',
    'UNDER_REVIEW',
    'ACTIVE',
    'SUSPENDED',
    'INACTIVE',
  ] as const;

  if (!status || !allowedStatuses.includes(status as (typeof allowedStatuses)[number])) {
    sendError(
      res,
      'INVALID_INPUT',
      `Status must be one of: ${allowedStatuses.join(', ')}`,
      400
    );
    return;
  }

  const updated = await prisma.counselorProfile.update({
    where: { id },
    data: { status: status as any },
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true, timezone: true } } },
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'UPDATE_COUNSELOR_STATUS',
    targetEntity: 'CounselorProfile',
    targetId: id,
    ipAddress: typeof req.ip === 'string' ? req.ip : null,
    details: { status },
  });

  sendSuccess(res, updated);
});

/**
 * GET /api/v1/admin/calendar
 * GET /api/v1/admin/sessions
 * Master calendar filterable counselor-wise and student-wise
 */
const getMasterCalendar = async (req: AuthenticatedRequest, res: Response) => {
  const counselorId = typeof req.query.counselorId === 'string' ? req.query.counselorId : undefined;
  const studentId = typeof req.query.studentId === 'string' ? req.query.studentId : undefined;
  const startDate = typeof req.query.startDate === 'string' ? new Date(req.query.startDate) : undefined;
  const endDate = typeof req.query.endDate === 'string' ? new Date(req.query.endDate) : undefined;

  if ((startDate && Number.isNaN(startDate.getTime())) || (endDate && Number.isNaN(endDate.getTime()))) {
    sendError(res, 'INVALID_INPUT', 'startDate and endDate must be valid dates', 400);
    return;
  }

  const where: any = { deletedAt: null };
  if (counselorId) where.counselorId = counselorId;
  if (studentId) where.studentId = studentId;

  if (startDate || endDate) {
    where.startTime = {};
    if (startDate) where.startTime.gte = startDate;
    if (endDate) where.startTime.lte = endDate;
  }

  const sessions = await prisma.counselorSession.findMany({
    where,
    include: {
      counselor: {
        include: {
          user: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      },
      student: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
    orderBy: { startTime: 'asc' },
  });

  sendSuccess(res, sessions);
};

router.get('/calendar', getMasterCalendar);
router.get('/sessions', getMasterCalendar);

/**
 * PUT /api/v1/admin/sessions/:id/cancel
 * Admin cancels a scheduled counseling session
 */
router.put('/sessions/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  const { reason } = req.body as { reason?: string };

  const session = await prisma.counselorSession.findUnique({ where: { id } });
  if (!session || session.deletedAt) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  const updated = await prisma.counselorSession.update({
    where: { id },
    data: {
      status: 'CANCELLED_BY_COUNSELOR',
      cancellationReason: reason || 'Cancelled by Administrator from Master Calendar',
    },
    include: {
      counselor: { include: { user: { select: { firstName: true, lastName: true, email: true } } } },
      student: { select: { firstName: true, lastName: true, email: true } },
    },
  });

  // Both sides have this hour in their calendar and neither is looking at the
  // admin panel. Without a notification the student joins an empty Jitsi room and
  // the counselor waits for someone who is never coming.
  const when = updated.startTime.toUTCString();
  const cancelReason = reason || 'Cancelled by a WellMindly administrator';

  queueEmail({
    to: updated.student.email,
    subject: 'Your WellMindly counseling session has been cancelled',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #4f46e5; margin-top: 0;">Session Cancelled</h2>
        <p>Hello <strong>${escapeHtml(updated.student.firstName)}</strong>,</p>
        <p>Your session with ${escapeHtml(updated.counselor.user.firstName)} ${escapeHtml(updated.counselor.user.lastName)} on <strong>${when}</strong> has been cancelled.</p>
        <p style="margin: 4px 0;"><strong>Reason:</strong> ${escapeHtml(cancelReason)}</p>
        <p>You can book a new time from your dashboard whenever you are ready.</p>
      </div>
    `,
  });

  queueEmail({
    to: updated.counselor.user.email,
    subject: 'A session on your WellMindly calendar has been cancelled',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #4f46e5; margin-top: 0;">Session Cancelled</h2>
        <p>Hello <strong>${escapeHtml(updated.counselor.user.firstName)}</strong>,</p>
        <p>Your session with ${escapeHtml(updated.student.firstName)} ${escapeHtml(updated.student.lastName)} on <strong>${when}</strong> has been cancelled by an administrator.</p>
        <p style="margin: 4px 0;"><strong>Reason:</strong> ${escapeHtml(cancelReason)}</p>
      </div>
    `,
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'CANCEL_SESSION_BY_ADMIN',
    targetEntity: 'CounselorSession',
    targetId: id,
    details: { reason },
  });

  sendSuccess(res, updated);
});

/**
 * DELETE /api/v1/admin/sessions/:id
 * Admin soft-deletes a counseling session from Master Calendar
 */
router.delete('/sessions/:id', async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);

  const session = await prisma.counselorSession.findUnique({ where: { id } });
  // The cancel route above already treats a soft-deleted row as gone. Without the
  // same check here a second delete answers 200 and rewrites `deletedAt`, so the
  // admin UI reports success for a row it can no longer show.
  if (!session || session.deletedAt) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  await prisma.counselorSession.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'DELETE_SESSION_BY_ADMIN',
    targetEntity: 'CounselorSession',
    targetId: id,
  });

  sendSuccess(res, { message: 'Session deleted successfully' });
});

/**
 * PUT /api/v1/admin/sessions/:id/reschedule
 * Admin reschedules a counseling session to a new date, time, or counselor
 */
router.put('/sessions/:id/reschedule', async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  const { startTime, endTime, counselorId } = req.body as {
    startTime?: string;
    endTime?: string;
    counselorId?: string;
  };

  if (!startTime || !endTime) {
    sendError(res, 'INVALID_INPUT', 'startTime and endTime are required for rescheduling', 400);
    return;
  }

  const existingSession = await prisma.counselorSession.findUnique({ where: { id } });
  if (!existingSession || existingSession.deletedAt) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  // A cancelled or finished session is not a candidate for a new time. The update
  // below writes `status: 'CONFIRMED'` unconditionally, so without this guard
  // rescheduling a session the student had already cancelled silently put it back
  // on their calendar as confirmed, and a COMPLETED session could be moved into
  // the future and reopened.
  const reschedulableStatuses = ['PENDING', 'CONFIRMED'];
  if (!reschedulableStatuses.includes(existingSession.status)) {
    sendError(
      res,
      'INVALID_STATE',
      `A session with status ${existingSession.status} cannot be rescheduled`,
      409
    );
    return;
  }

  const targetCounselorId = counselorId || existingSession.counselorId;
  const newStart = new Date(startTime);
  const newEnd = new Date(endTime);

  // Same interval check the booking path now applies. A reversed or zero-length
  // window stored here can never be matched by the overlap query again, so it
  // becomes invisible to every later booking and reschedule.
  if (Number.isNaN(newStart.getTime()) || Number.isNaN(newEnd.getTime()) || newEnd <= newStart) {
    sendError(res, 'INVALID_TIME_RANGE', 'The new start and end times are not a valid window', 400);
    return;
  }

  // Check for conflicting active bookings for target counselor.
  // Strict comparisons: with lte/gte a session ending exactly when another starts
  // counted as a conflict, so moving a session into the free hour immediately
  // before or after an existing one was refused. Sessions are back-to-back hours
  // by design.
  const conflict = await prisma.counselorSession.findFirst({
    where: {
      id: { not: id },
      counselorId: targetCounselorId,
      status: { notIn: ['CANCELLED_BY_STUDENT', 'CANCELLED_BY_COUNSELOR', 'EXPIRED'] },
      deletedAt: null,
      startTime: { lt: newEnd },
      endTime: { gt: newStart },
    },
  });

  if (conflict) {
    sendError(res, 'SLOT_ALREADY_BOOKED', 'Target counselor has a conflicting booking at this time.', 409);
    return;
  }

  const updated = await prisma.counselorSession.update({
    where: { id },
    data: {
      counselorId: targetCounselorId,
      startTime: newStart,
      endTime: newEnd,
      status: 'CONFIRMED',
    },
    include: {
      counselor: { include: { user: { select: { firstName: true, lastName: true, email: true } } } },
      student: { select: { firstName: true, lastName: true, email: true } },
    },
  });

  // Same reasoning as the cancel route: the old hour is gone from the calendar and
  // nobody outside the admin panel knows the session moved.
  queueEmail({
    to: updated.student.email,
    subject: 'Your WellMindly counseling session has been rescheduled',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #4f46e5; margin-top: 0;">New Session Time</h2>
        <p>Hello <strong>${escapeHtml(updated.student.firstName)}</strong>,</p>
        <p>Your session with ${escapeHtml(updated.counselor.user.firstName)} ${escapeHtml(updated.counselor.user.lastName)} has been moved.</p>
        <p style="margin: 4px 0;"><strong>Previous time:</strong> ${existingSession.startTime.toUTCString()}</p>
        <p style="margin: 4px 0;"><strong>New time:</strong> ${newStart.toUTCString()}</p>
        ${updated.meetingLink ? `<p style="margin: 16px 0;"><a href="${updated.meetingLink}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Join Session</a></p>` : ''}
      </div>
    `,
  });

  queueEmail({
    to: updated.counselor.user.email,
    subject: 'A session on your WellMindly calendar has been rescheduled',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #4f46e5; margin-top: 0;">New Session Time</h2>
        <p>Hello <strong>${escapeHtml(updated.counselor.user.firstName)}</strong>,</p>
        <p>Your session with ${escapeHtml(updated.student.firstName)} ${escapeHtml(updated.student.lastName)} has been moved by an administrator.</p>
        <p style="margin: 4px 0;"><strong>Previous time:</strong> ${existingSession.startTime.toUTCString()}</p>
        <p style="margin: 4px 0;"><strong>New time:</strong> ${newStart.toUTCString()}</p>
      </div>
    `,
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'RESCHEDULE_SESSION_BY_ADMIN',
    targetEntity: 'CounselorSession',
    targetId: id,
    details: { newStart, newEnd, targetCounselorId },
  });

  sendSuccess(res, updated);
});

/**
 * GET /api/v1/admin/feedback
 * Dual feedback overview (Student -> Counselor and Counselor -> Student)
 */
router.get('/feedback', async (req: AuthenticatedRequest, res: Response) => {
  const [studentFeedbacks, counselorFeedbacks] = await Promise.all([
    prisma.studentFeedback.findMany({
      include: {
        counselor: { include: { user: { select: { firstName: true, lastName: true } } } },
        session: { include: { student: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.counselorFeedback.findMany({
      include: {
        counselor: { include: { user: { select: { firstName: true, lastName: true } } } },
        session: { include: { student: { select: { firstName: true, lastName: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  sendSuccess(res, { studentToCounselor: studentFeedbacks, counselorToStudent: counselorFeedbacks });
});

/**
 * GET /api/v1/admin/analytics
 * Platform aggregated performance metrics
 */
router.get('/analytics', async (req: AuthenticatedRequest, res: Response) => {
  const [totalCounselors, totalStudents, totalSessions, completedSessions, avgRating] = await Promise.all([
    prisma.counselorProfile.count({ where: { status: 'ACTIVE', deletedAt: null } }),
    prisma.user.count({ where: { role: 'STUDENT', deletedAt: null } }),
    prisma.counselorSession.count({ where: { deletedAt: null } }),
    prisma.counselorSession.count({ where: { status: 'COMPLETED', deletedAt: null } }),
    // Every other figure on this card excludes soft-deleted rows; the average
    // has to as well, or it moves when a session is removed and nothing else does.
    prisma.studentFeedback.aggregate({ _avg: { rating: true }, where: { deletedAt: null } }),
  ]);

  sendSuccess(res, {
    totalCounselors,
    totalStudents,
    totalSessions,
    completedSessions,
    completionRate: totalSessions > 0 ? ((completedSessions / totalSessions) * 100).toFixed(1) + '%' : '0%',
    averageRating: avgRating._avg.rating ? avgRating._avg.rating.toFixed(2) : 'N/A',
  });
});

/**
 * GET /api/v1/admin/audit-logs
 * Fetch recent audit logs
 */
router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response) => {
  const logs = await prisma.auditLog.findMany({
    include: {
      actor: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  sendSuccess(res, logs);
});



export default router;
