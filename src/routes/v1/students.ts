import { Router, Response } from 'express';
import prisma from '../../lib/prisma';
import { authenticateJWT, requireRoles, AuthenticatedRequest } from '../../middleware/rbac';
import { sendSuccess, sendError } from '../../utils/response';
import { generateBookableSlots } from '../../services/slotGenerator';
import { bookSessionTransaction } from '../../services/bookingService';
import { logAuditEvent } from '../../utils/auditLogger';
import { queueEmail } from '../../utils/emailQueue';
import { escapeHtml } from '../../utils/escapeHtml';
import { isStudentEligible } from '../../services/accessControl';

const router = Router();

// Protect student endpoints with JWT
router.use(authenticateJWT, requireRoles(['STUDENT', 'ADMIN', 'SUPER_ADMIN']));

/**
 * GET /api/v1/students/counselors
 * Directory of active counselors with credentials & ratings
 */
router.get('/counselors', async (req: AuthenticatedRequest, res: Response) => {
  const counselors = await prisma.counselorProfile.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      receivedFeedback: {
        select: { rating: true },
      },
    },
  });

  const formatted = counselors.map((c) => {
    const ratings = c.receivedFeedback.map((f) => f.rating);
    const avgRating =
      ratings.length > 0
        ? parseFloat((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1))
        : null;

    return {
      id: c.id,
      userId: c.userId,
      name: `${c.user.firstName} ${c.user.lastName}`,
      credentials: c.credentials,
      specializations: c.specializations,
      bio: c.bio,
      avatarUrl: c.avatarUrl,
      averageRating: avgRating,
      totalReviews: ratings.length,
    };
  });

  sendSuccess(res, formatted);
});

/**
 * GET /api/v1/students/counselors/slots
 * Bi-directional slot generator endpoint
 * Query params: counselorId (optional), date (ISO date string, e.g. "2026-07-29")
 */
router.get('/counselors/slots', async (req: AuthenticatedRequest, res: Response) => {
  const counselorId = typeof req.query.counselorId === 'string' ? req.query.counselorId : undefined;
  const dateStr = typeof req.query.date === 'string' ? req.query.date : undefined;

  const targetDate = dateStr ? new Date(dateStr) : new Date();
  const startDateUtc = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), 0, 0, 0));
  const endDateUtc = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), 23, 59, 59));

  if (counselorId) {
    // Mode 1: Fetch all slots for selected counselor on date
    const slots = await generateBookableSlots(counselorId, startDateUtc, endDateUtc);
    sendSuccess(res, { counselorId, date: targetDate.toISOString().split('T')[0], slots });
    return;
  }

  // Mode 2: Fetch available counselors for a given time window / date
  const activeCounselors = await prisma.counselorProfile.findMany({
    where: { status: 'ACTIVE', deletedAt: null },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });

  const counselorSlotResults = await Promise.all(
    activeCounselors.map(async (c) => {
      const slots = await generateBookableSlots(c.id, startDateUtc, endDateUtc);
      const availableSlots = slots.filter((s) => s.isAvailable);
      return {
        counselorId: c.id,
        name: `${c.user.firstName} ${c.user.lastName}`,
        specializations: c.specializations,
        availableSlotsCount: availableSlots.length,
        slots,
      };
    })
  );

  sendSuccess(res, counselorSlotResults);
});

/**
 * POST /api/v1/students/sessions/book
 * Atomic session booking with double-booking lock
 */
router.post('/sessions/book', async (req: AuthenticatedRequest, res: Response) => {
  const { counselorId, startTime, endTime } = req.body as {
    counselorId?: string;
    startTime?: string;
    endTime?: string;
  };

  if (!counselorId || !startTime || !endTime) {
    sendError(res, 'INVALID_INPUT', 'counselorId, startTime, and endTime are required', 400);
    return;
  }

  // Server-side guard: Only verified university students or bypass accounts can book 1-on-1 human coaching
  let userEmail = req.user?.email;
  if (!userEmail && req.user?.sub) {
    const u = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { email: true, universityId: true },
    });
    userEmail = u?.email;
  }

  const eligibility = await isStudentEligible(userEmail || '');
  if (!eligibility.eligible && !req.user?.universityId) {
    sendError(
      res,
      'ELIGIBILITY_RESTRICTED',
      '1-on-1 human counseling is currently available only for verified university students.',
      403
    );
    return;
  }

  try {
    const session = await bookSessionTransaction({
      studentId: req.user!.sub,
      counselorId,
      startTimeUtc: new Date(startTime),
      endTimeUtc: new Date(endTime),
      ipAddress: req.ip || undefined,
    });


    sendSuccess(res, session, 201);
  } catch (err: any) {
    // bookSessionTransaction throws a bare code; each one gets a message the
    // booking UI can show as-is.
    const messages: Record<string, { status: number; message: string }> = {
      SLOT_ALREADY_BOOKED: {
        status: 409,
        message: 'Selected slot is no longer available. Please select another slot.',
      },
      SLOT_BLOCKED: {
        status: 409,
        message: 'The counselor is no longer available at that time. Please select another slot.',
      },
      SLOT_IN_THE_PAST: {
        status: 400,
        message: 'That time has already passed. Please choose an upcoming slot.',
      },
      SLOT_NOT_OFFERED: {
        status: 400,
        message: 'That time is not one of the counselor’s bookable slots. Please pick a slot from the list.',
      },
      INVALID_TIME_RANGE: { status: 400, message: 'The session start and end times are not valid.' },
      COUNSELOR_NOT_AVAILABLE: {
        status: 409,
        message: 'That counselor is not currently accepting sessions.',
      },
    };

    const mapped = messages[err?.message as string];
    if (mapped) {
      sendError(res, err.message, mapped.message, mapped.status);
    } else {
      sendError(res, 'BOOKING_FAILED', err.message || 'Failed to book session', 400);
    }
  }
});

/**
 * GET /api/v1/students/sessions/me
 * List student's booked sessions
 */
router.get('/sessions/me', async (req: AuthenticatedRequest, res: Response) => {
  const sessions = await prisma.counselorSession.findMany({
    where: { studentId: req.user?.sub, deletedAt: null },
    include: {
      counselor: {
        include: { user: { select: { firstName: true, lastName: true, email: true } } },
      },
      studentFeedback: true,
    },
    orderBy: { startTime: 'desc' },
  });

  sendSuccess(res, sessions);
});

/**
 * POST /api/v1/students/sessions/:id/cancel
 * Student session cancellation
 */
router.post('/sessions/:id/cancel', async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  const { reason } = req.body as { reason?: string };

  const session = await prisma.counselorSession.findFirst({
    where: { id, studentId: req.user?.sub },
    include: {
      counselor: { include: { user: true } },
      student: true,
    },
  });

  if (!session) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  // Check 30-minute cancellation rule
  const now = new Date();
  const diffMins = Math.floor((session.startTime.getTime() - now.getTime()) / (1000 * 60));
  if (diffMins < 30) {
    sendError(res, 'CANCELLATION_RESTRICTED', 'Sessions cannot be cancelled within 30 minutes of start time', 400);
    return;
  }

  const updated = await prisma.counselorSession.update({
    where: { id },
    data: {
      status: 'CANCELLED_BY_STUDENT',
      cancellationReason: reason || 'Cancelled by student',
    },
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'CANCEL_SESSION_BY_STUDENT',
    targetEntity: 'CounselorSession',
    targetId: id,
  });

  // Queue async cancellation emails
  const formattedTime = session.startTime.toUTCString();
  const studentReason = reason || 'Cancelled by student';

  // Notification to student
  queueEmail({
    to: session.student.email,
    subject: `Cancelled: Counseling Session on ${formattedTime}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
        <h2 style="color: #4f46e5;">Counseling Session Cancelled</h2>
        <p>Hello <strong>${escapeHtml(session.student.firstName)}</strong>,</p>
        <p>Your session with <strong>${escapeHtml(session.counselor.user.firstName)} ${escapeHtml(session.counselor.user.lastName)}</strong> has been cancelled.</p>
        <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 20px 0;">
          <p style="margin: 4px 0;"><strong>Date & Time (UTC):</strong> ${formattedTime}</p>
          <p style="margin: 4px 0;"><strong>Counselor:</strong> ${escapeHtml(session.counselor.user.firstName)} ${escapeHtml(session.counselor.user.lastName)}</p>
          <p style="margin: 4px 0;"><strong>Reason:</strong> ${escapeHtml(studentReason)}</p>
        </div>
        <p style="color: #64748b; font-size: 14px;">You can book another session whenever you are ready.</p>
      </div>
    `,
  });

  // Notification to counselor
  queueEmail({
    to: session.counselor.user.email,
    subject: `Session Cancelled by ${session.student.firstName} ${session.student.lastName}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
        <h2 style="color: #4f46e5;">Session Cancelled by Student</h2>
        <p>Hello <strong>${escapeHtml(session.counselor.user.firstName)}</strong>,</p>
        <p>Student <strong>${escapeHtml(session.student.firstName)} ${escapeHtml(session.student.lastName)}</strong> has cancelled their scheduled session.</p>
        <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 20px 0;">
          <p style="margin: 4px 0;"><strong>Cancelled Time (UTC):</strong> ${formattedTime}</p>
        </div>
        <p style="color: #64748b; font-size: 14px;">This slot is now available for other students to book.</p>
      </div>
    `,
  });

  sendSuccess(res, updated);
});

/**
 * POST /api/v1/students/sessions/:id/feedback
 * Submit student feedback & rating for counselor
 */
router.post('/sessions/:id/feedback', async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = String(req.params.id);
  const { rating, comments, answers } = req.body as {
    rating?: number;
    comments?: string;
    answers?: any;
  };

  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    sendError(res, 'INVALID_INPUT', 'Rating must be an integer between 1 and 5', 400);
    return;
  }

  const session = await prisma.counselorSession.findFirst({
    where: { id: sessionId, studentId: req.user?.sub },
  });

  if (!session) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  // StudentFeedback.sessionId is @unique. Without this check a second submit
  // reaches Prisma and comes back as a generic "that value is already taken",
  // which is not something to show in a feedback form.
  const existing = await prisma.studentFeedback.findUnique({ where: { sessionId } });
  if (existing) {
    sendError(res, 'ALREADY_EXISTS', 'You have already left feedback for this session', 409);
    return;
  }

  const feedback = await prisma.studentFeedback.create({
    data: {
      sessionId,
      counselorId: session.counselorId,
      studentId: session.studentId,
      rating,
      comments: comments || '',
      answers: answers || {},
    },
  });

  sendSuccess(res, feedback, 201);
});

export default router;
