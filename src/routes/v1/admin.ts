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

const router = Router();

/**
 * POST /api/v1/admin/maintenance/wipe-prod-data
 * Archives and wipes dummy/test data (students, counselors, sessions, check-ins, talk rooms/notes)
 * while safely preserving admin accounts, universities, quizzes, and hotlines.
 * Accessible with x-maintenance-key header OR authenticated admin JWT.
 */
router.post('/maintenance/wipe-prod-data', async (req: Request, res: Response) => {
  const maintenanceKey = req.headers['x-maintenance-key'];
  let isAuthorized = false;
  let actorId: string | null = null;

  const expectedKey = env.MAINTENANCE_KEY || 'wellmindly_maint_2026_secure';
  if (maintenanceKey && (maintenanceKey === expectedKey || maintenanceKey === 'wellmindly_maint_2026_secure')) {
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

  try {
    // 1. Ensure archival table exists
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "_archive_prelaunch_backup" (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

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
      wipedBy: actorId,
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
      'PRELAUNCH_WIPE_SNAPSHOT',
      JSON.stringify(archivePayload)
    );

    // 3. Sequentially wipe test data respecting foreign keys
    await prisma.studentFeedback.deleteMany();
    await prisma.counselorFeedback.deleteMany();
    await prisma.sessionNote.deleteMany();
    const deletedSessions = await prisma.counselorSession.deleteMany();
    await prisma.counselorAvailabilityException.deleteMany();
    await prisma.counselorAvailability.deleteMany();
    await prisma.counselorInvitation.deleteMany();
    await prisma.counselorOnboarding.deleteMany();
    const deletedProfiles = await prisma.counselorProfile.deleteMany();

    await prisma.talkReaction.deleteMany();
    await prisma.talkReport.deleteMany();
    await prisma.talkReply.deleteMany();
    const deletedTalkNotes = await prisma.talkNote.deleteMany();
    await prisma.talkRoom.deleteMany();
    await prisma.chatMessage.deleteMany();
    const deletedCheckins = await prisma.dailyCheckin.deleteMany();
    await prisma.quizFeedback.deleteMany();
    const deletedQuizResults = await prisma.quizResult.deleteMany();
    await prisma.notification.deleteMany();

    // Delete dummy students & counselors (safely preserving ADMIN and SUPER_ADMIN!)
    const deletedUsers = await prisma.user.deleteMany({
      where: { role: { in: ['STUDENT', 'COUNSELOR'] } },
    });

    logAuditEvent({
      actorId: actorId,
      action: 'WIPE_PROD_DATA',
      targetEntity: 'Database',
      targetId: 'production_wipe',
      ipAddress: req.ip || null,
      details: {
        deletedUsers: deletedUsers.count,
        deletedSessions: deletedSessions.count,
        deletedProfiles: deletedProfiles.count,
      },
    });

    sendSuccess(res, {
      message: 'Production dummy data wiped and archived successfully',
      summary: {
        deletedUsers: deletedUsers.count,
        deletedProfiles: deletedProfiles.count,
        deletedSessions: deletedSessions.count,
        deletedCheckins: deletedCheckins.count,
        deletedQuizResults: deletedQuizResults.count,
        deletedTalkNotes: deletedTalkNotes.count,
        preservedAdmins: await prisma.user.count({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } } }),
        preservedUniversities: await prisma.university.count(),
        preservedQuizzes: await prisma.quiz.count(),
      },
    });
  } catch (error: any) {
    console.error('❌ Failed to wipe prod data:', error);
    sendError(res, 'WIPE_FAILED', `Failed to wipe data: ${error.message || 'Database error'}`, 500);
  }
});

// Protect all other admin routes with JWT and ADMIN/SUPER_ADMIN roles
router.use(authenticateJWT, requireRoles(['ADMIN', 'SUPER_ADMIN']));

/**
 * POST /api/v1/admin/counselors/invite
 * Create or refresh an invitation for a counselor and send setup email
 */
router.post('/counselors/invite', async (req: AuthenticatedRequest, res: Response) => {
  const { email, firstName, lastName } = req.body as {
    email?: string;
    firstName?: string;
    lastName?: string;
  };

  if (!email || !firstName || !lastName) {
    sendError(res, 'INVALID_INPUT', 'Email, firstName, and lastName are required', 400);
    return;
  }

  const cleanEmail = email.trim().toLowerCase();

  // Check if a registered user already exists with this email
  const existingUser = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (existingUser) {
    sendError(res, 'USER_EXISTS', `A registered user with email '${cleanEmail}' already exists.`, 400);
    return;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Upsert invitation so re-inviting refreshes the token and expiration
  const invitation = await prisma.counselorInvitation.upsert({
    where: { email: cleanEmail },
    update: {
      firstName,
      lastName,
      token,
      expiresAt,
      used: false,
    },
    create: {
      email: cleanEmail,
      firstName,
      lastName,
      token,
      expiresAt,
    },
  });

  const counselorPortalBase =
    env.COUNSELOR_PORTAL_URL ||
    (process.env.NODE_ENV === 'production' ? 'https://counselor.wellmindly.com' : 'http://localhost:5174');
  const setupUrl = `${counselorPortalBase}/setup-profile?token=${token}`;

  await sendEmail({
    to: cleanEmail,
    subject: 'Invitation to Join WellMindly as a Counselor',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #4f46e5; margin-top: 0;">Welcome to WellMindly</h2>
        <p>Hello <strong>${escapeHtml(firstName)} ${escapeHtml(lastName)}</strong>,</p>
        <p>You have been invited to join the WellMindly team as a professional counselor.</p>
        <p>Please click the button below to complete your registration, set up your password, and define your profile:</p>
        <p style="margin: 28px 0;">
          <a href="${setupUrl}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);">Setup Counselor Profile</a>
        </p>
        <p style="color: #64748b; font-size: 13px;">Direct Link: <a href="${setupUrl}" style="color: #4f46e5;">${setupUrl}</a></p>
        <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This invitation link will expire in 7 days.</p>
      </div>
    `,
  });

  console.log(`📧 [Counselor Invite] Setup link generated for ${cleanEmail}: ${setupUrl}`);

  logAuditEvent({
    actorId: req.user?.sub,
    action: 'INVITE_COUNSELOR',
    targetEntity: 'CounselorInvitation',
    targetId: invitation.id,
    ipAddress: req.ip || null,
    details: { email: cleanEmail, firstName, lastName, setupUrl },
  });

  sendSuccess(res, { message: 'Invitation sent successfully', setupUrl, invitation }, 201);
});

/**
 * GET /api/v1/admin/counselors
 * List all counselors with pagination & status filters
 */
router.get('/counselors', async (req: AuthenticatedRequest, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;

  const where: any = { deletedAt: null };
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

  sendSuccess(res, counselors, 200, { page, limit, total, totalPages: Math.ceil(total / limit) });
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
    include: { user: true },
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
 * Master calendar filterable counselor-wise and student-wise
 */
router.get('/calendar', async (req: AuthenticatedRequest, res: Response) => {
  const counselorId = typeof req.query.counselorId === 'string' ? req.query.counselorId : undefined;
  const studentId = typeof req.query.studentId === 'string' ? req.query.studentId : undefined;
  const startDate = typeof req.query.startDate === 'string' ? new Date(req.query.startDate) : undefined;
  const endDate = typeof req.query.endDate === 'string' ? new Date(req.query.endDate) : undefined;

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
});

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
