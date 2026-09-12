"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const prisma_1 = __importDefault(require("../../lib/prisma"));
const jwt_1 = require("../../lib/jwt");
const rbac_1 = require("../../middleware/rbac");
const response_1 = require("../../utils/response");
const emailQueue_1 = require("../../utils/emailQueue");
const auditLogger_1 = require("../../utils/auditLogger");
const s3_1 = require("../../utils/s3");
const escapeHtml_1 = require("../../utils/escapeHtml");
const router = (0, express_1.Router)();
/**
 * POST /api/v1/counselors/verify-invite
 * Check validity of counselor invitation token
 */
router.post('/verify-invite', async (req, res) => {
    const { token } = req.body;
    if (!token) {
        (0, response_1.sendError)(res, 'INVALID_INPUT', 'Invitation token is required', 400);
        return;
    }
    const invitation = await prisma_1.default.counselorInvitation.findUnique({
        where: { token },
    });
    if (!invitation || invitation.used || invitation.expiresAt < new Date()) {
        (0, response_1.sendError)(res, 'INVALID_INVITE', 'Invitation link is invalid or expired', 400);
        return;
    }
    (0, response_1.sendSuccess)(res, {
        email: invitation.email,
        firstName: invitation.firstName,
        lastName: invitation.lastName,
    });
});
/**
 * POST /api/v1/counselors/setup-profile
 * Complete password setup and create counselor account from invite token
 */
router.post('/setup-profile', async (req, res) => {
    const { token, password, credentials, specializations, bio, phone, timezone } = req.body;
    if (!token || !password || !credentials) {
        (0, response_1.sendError)(res, 'INVALID_INPUT', 'Token, password, and credentials are required', 400);
        return;
    }
    const invitation = await prisma_1.default.counselorInvitation.findUnique({ where: { token } });
    if (!invitation || invitation.used || invitation.expiresAt < new Date()) {
        (0, response_1.sendError)(res, 'INVALID_INVITE', 'Invitation link is invalid or expired', 400);
        return;
    }
    const passwordHash = await bcrypt_1.default.hash(password, 10);
    // Transaction: Create user, create profile, mark invite used
    const user = await prisma_1.default.$transaction(async (tx) => {
        const newUser = await tx.user.create({
            data: {
                email: invitation.email,
                firstName: invitation.firstName,
                lastName: invitation.lastName,
                passwordHash,
                role: 'COUNSELOR',
                timezone: timezone || 'UTC',
            },
        });
        await tx.counselorProfile.create({
            data: {
                userId: newUser.id,
                credentials,
                specializations: specializations || ['General Wellness'],
                bio: bio || '',
                phone: phone || '',
                status: 'ACTIVE',
            },
        });
        await tx.counselorInvitation.update({
            where: { id: invitation.id },
            data: { used: true },
        });
        return newUser;
    });
    const jwtToken = (0, jwt_1.signToken)({
        sub: user.id,
        email: user.email,
        role: user.role,
        universityId: null,
    });
    (0, auditLogger_1.logAuditEvent)({
        actorId: user.id,
        action: 'REGISTER_COUNSELOR',
        targetEntity: 'User',
        targetId: user.id,
        ipAddress: req.ip || null,
    });
    (0, response_1.sendSuccess)(res, { token: jwtToken, user: { id: user.id, email: user.email, role: user.role } }, 201);
});
/**
 * POST /api/v1/counselors/login
 * Counselor Authentication
 */
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        (0, response_1.sendError)(res, 'INVALID_INPUT', 'Email and password are required', 400);
        return;
    }
    const user = await prisma_1.default.user.findUnique({
        where: { email },
        include: { counselorProfile: true },
    });
    if (!user || user.role !== 'COUNSELOR' || !user.passwordHash) {
        (0, response_1.sendError)(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
        return;
    }
    const validPassword = await bcrypt_1.default.compare(password, user.passwordHash);
    if (!validPassword) {
        (0, response_1.sendError)(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
        return;
    }
    if (user.counselorProfile?.status === 'SUSPENDED') {
        (0, response_1.sendError)(res, 'ACCOUNT_SUSPENDED', 'Your counselor account is suspended', 403);
        return;
    }
    const token = (0, jwt_1.signToken)({
        sub: user.id,
        email: user.email,
        role: user.role,
        universityId: null,
    });
    (0, response_1.sendSuccess)(res, {
        token,
        user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            counselorProfile: user.counselorProfile,
        },
    });
});
// Protected routes below
router.use(rbac_1.authenticateJWT, (0, rbac_1.requireRoles)(['COUNSELOR', 'ADMIN', 'SUPER_ADMIN']));
/**
 * GET /api/v1/counselors/me/profile
 */
router.get('/me/profile', async (req, res) => {
    const profile = await prisma_1.default.counselorProfile.findUnique({
        where: { userId: req.user?.sub },
        include: {
            user: {
                select: { id: true, email: true, firstName: true, lastName: true, timezone: true },
            },
            availabilities: true,
            exceptions: true,
        },
    });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Counselor profile not found', 404);
        return;
    }
    (0, response_1.sendSuccess)(res, profile);
});
/**
 * PUT /api/v1/counselors/me/profile
 */
router.put('/me/profile', async (req, res) => {
    const { specializations, credentials, bio, phone, avatarUrl, timezone } = req.body;
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Counselor profile not found', 404);
        return;
    }
    if (timezone) {
        await prisma_1.default.user.update({
            where: { id: req.user?.sub },
            data: { timezone },
        });
    }
    const updatedProfile = await prisma_1.default.counselorProfile.update({
        where: { id: profile.id },
        data: {
            specializations,
            credentials,
            bio,
            phone,
            avatarUrl,
        },
        include: { user: true },
    });
    (0, response_1.sendSuccess)(res, updatedProfile);
});
/**
 * POST /api/v1/counselors/me/upload
 * Upload profile picture to AWS S3 bucket wellmindly-assets (us-east-1)
 */
router.post('/me/upload', rbac_1.authenticateJWT, (0, rbac_1.requireRoles)(['COUNSELOR', 'ADMIN', 'SUPER_ADMIN']), async (req, res) => {
    try {
        const { fileName, mimeType, base64Data, folder } = req.body || {};
        if (!base64Data) {
            (0, response_1.sendError)(res, 'INVALID_INPUT', 'base64Data is required', 400);
            return;
        }
        const cleanBase64 = base64Data.includes('base64,')
            ? base64Data.split('base64,')[1]
            : base64Data;
        const buffer = Buffer.from(cleanBase64, 'base64');
        const name = fileName || `avatar_${Date.now()}.png`;
        const type = mimeType || 'image/png';
        const result = await (0, s3_1.uploadToS3)(buffer, name, type, folder || 'avatars');
        (0, response_1.sendSuccess)(res, {
            message: 'File uploaded to AWS S3 successfully',
            url: result.url,
            key: result.key,
        });
    }
    catch (error) {
        console.error('Error uploading file to S3:', error);
        (0, response_1.sendError)(res, 'UPLOAD_FAILED', 'Failed to upload file to S3', 500);
    }
});
/**
 * PUT /api/v1/counselors/me/account
 * Update email and/or password for counselor account
 */
router.put('/me/account', async (req, res) => {
    try {
        const userId = req.user?.sub;
        if (!userId) {
            (0, response_1.sendError)(res, 'UNAUTHORIZED', 'Unauthorized', 401);
            return;
        }
        const { email, currentPassword, newPassword } = req.body;
        const user = await prisma_1.default.user.findUnique({ where: { id: userId } });
        if (!user) {
            (0, response_1.sendError)(res, 'NOT_FOUND', 'User not found', 404);
            return;
        }
        const updateData = {};
        // 1. Update Email
        if (email && email.trim().toLowerCase() !== user.email.toLowerCase()) {
            const cleanEmail = email.trim().toLowerCase();
            const existing = await prisma_1.default.user.findUnique({ where: { email: cleanEmail } });
            if (existing) {
                (0, response_1.sendError)(res, 'EMAIL_TAKEN', 'This email address is already in use by another user.', 400);
                return;
            }
            updateData.email = cleanEmail;
        }
        // 2. Update Password
        if (newPassword) {
            if (!currentPassword) {
                (0, response_1.sendError)(res, 'INVALID_INPUT', 'Current password is required to set a new password.', 400);
                return;
            }
            if (user.passwordHash) {
                const isValid = await bcrypt_1.default.compare(currentPassword, user.passwordHash);
                if (!isValid) {
                    (0, response_1.sendError)(res, 'INVALID_CREDENTIALS', 'Current password entered is incorrect.', 400);
                    return;
                }
            }
            if (newPassword.length < 6) {
                (0, response_1.sendError)(res, 'INVALID_INPUT', 'New password must be at least 6 characters long.', 400);
                return;
            }
            updateData.passwordHash = await bcrypt_1.default.hash(newPassword, 10);
        }
        if (Object.keys(updateData).length === 0) {
            (0, response_1.sendError)(res, 'INVALID_INPUT', 'No account fields were changed.', 400);
            return;
        }
        const updatedUser = await prisma_1.default.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                role: true,
                timezone: true,
            },
        });
        (0, auditLogger_1.logAuditEvent)({
            actorId: userId,
            action: 'UPDATE_COUNSELOR_ACCOUNT',
            targetEntity: 'User',
            targetId: userId,
            details: { updatedEmail: !!updateData.email, updatedPassword: !!updateData.passwordHash },
        });
        (0, response_1.sendSuccess)(res, { user: updatedUser, message: 'Account credentials updated successfully.' });
    }
    catch (err) {
        console.error('Error updating counselor account:', err);
        (0, response_1.sendError)(res, 'INTERNAL_ERROR', err?.message || 'Failed to update account credentials', 500);
    }
});
/**
 * GET /api/v1/counselors/me/exceptions
 * Fetch date-specific blocked hours
 */
router.get('/me/exceptions', async (req, res) => {
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Profile not found', 404);
        return;
    }
    const exceptions = await prisma_1.default.counselorAvailabilityException.findMany({
        where: { counselorId: profile.id },
        orderBy: { startDate: 'asc' },
    });
    (0, response_1.sendSuccess)(res, exceptions);
});
/**
 * POST /api/v1/counselors/me/exceptions
 * Block specific date/time hours
 */
router.post('/me/exceptions', async (req, res) => {
    const { startDate, endDate, reason, isFullDay } = req.body;
    if (!startDate || !endDate) {
        (0, response_1.sendError)(res, 'INVALID_INPUT', 'startDate and endDate are required', 400);
        return;
    }
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Profile not found', 404);
        return;
    }
    const exception = await prisma_1.default.counselorAvailabilityException.create({
        data: {
            counselorId: profile.id,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            isFullDay: isFullDay ?? false,
            reason: reason || 'Blocked by Counselor',
        },
    });
    (0, auditLogger_1.logAuditEvent)({
        actorId: req.user?.sub || null,
        action: 'BLOCK_COUNSELOR_HOURS',
        targetEntity: 'CounselorAvailabilityException',
        targetId: exception.id,
        details: { startDate, endDate, reason },
    });
    (0, response_1.sendSuccess)(res, exception, 201);
});
/**
 * DELETE /api/v1/counselors/me/exceptions/:id
 * Unblock hours
 */
router.delete('/me/exceptions/:id', async (req, res) => {
    const id = String(req.params.id);
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Profile not found', 404);
        return;
    }
    await prisma_1.default.counselorAvailabilityException.deleteMany({
        where: { id, counselorId: profile.id },
    });
    (0, response_1.sendSuccess)(res, { message: 'Blockout removed successfully' });
});
/**
 * PUT /api/v1/counselors/me/availability
 * Replace weekly availability rules
 */
router.put('/me/availability', async (req, res) => {
    const { availabilities } = req.body;
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Profile not found', 404);
        return;
    }
    await prisma_1.default.$transaction(async (tx) => {
        await tx.counselorAvailability.deleteMany({ where: { counselorId: profile.id } });
        if (availabilities && availabilities.length > 0) {
            await tx.counselorAvailability.createMany({
                data: availabilities.map((a) => ({
                    counselorId: profile.id,
                    dayOfWeek: a.dayOfWeek,
                    startTime: a.startTime,
                    endTime: a.endTime,
                    slotDurationMins: 60, // Fixed 60 minutes
                    isAvailable: true,
                })),
            });
        }
    });
    const updated = await prisma_1.default.counselorAvailability.findMany({
        where: { counselorId: profile.id },
    });
    (0, response_1.sendSuccess)(res, updated);
});
/**
 * GET /api/v1/counselors/me/sessions
 */
router.get('/me/sessions', async (req, res) => {
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Profile not found', 404);
        return;
    }
    const sessions = await prisma_1.default.counselorSession.findMany({
        where: { counselorId: profile.id, deletedAt: null },
        include: {
            student: { select: { id: true, firstName: true, lastName: true, email: true } },
            notes: true,
            studentFeedback: true,
            counselorFeedback: true,
        },
        orderBy: { startTime: 'desc' },
    });
    (0, response_1.sendSuccess)(res, sessions);
});
/**
 * POST /api/v1/counselors/me/sessions/:id/notes
 * Add or update session note
 */
router.post('/me/sessions/:id/notes', async (req, res) => {
    const sessionId = String(req.params.id);
    const { title, content, isPrivate, isDraft } = req.body;
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    const session = await prisma_1.default.counselorSession.findUnique({ where: { id: sessionId } });
    if (!profile || !session) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Session or profile not found', 404);
        return;
    }
    // A note may only be written against the counselor's own session. Without this
    // check any counselor could write into another counselor's clinical record,
    // and the note would then surface in their own student timeline view.
    if (session.counselorId !== profile.id) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Session not found', 404);
        return;
    }
    const note = await prisma_1.default.sessionNote.create({
        data: {
            sessionId,
            counselorId: profile.id,
            studentId: session.studentId,
            title: title || 'Session Note',
            content: content || '',
            isPrivate: isPrivate ?? true,
            isDraft: isDraft ?? false,
        },
    });
    (0, auditLogger_1.logAuditEvent)({
        actorId: req.user?.sub || null,
        action: 'CREATE_SESSION_NOTE',
        targetEntity: 'SessionNote',
        targetId: note.id,
    });
    (0, response_1.sendSuccess)(res, note, 201);
});
/**
 * GET /api/v1/counselors/me/students/:studentId/timeline
 * Student historical timeline (notes, sessions, feedback)
 */
router.get('/me/students/:studentId/timeline', async (req, res) => {
    const studentId = String(req.params.studentId);
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Profile not found', 404);
        return;
    }
    const [student, sessions, notes] = await Promise.all([
        // Scoped to a student this counselor actually has a session or a note with.
        // A plain findUnique on studentId turned this route into a lookup for any
        // user's name and email by uuid.
        prisma_1.default.user.findFirst({
            where: {
                id: studentId,
                studentSessions: { some: { counselorId: profile.id, deletedAt: null } },
            },
            select: { id: true, firstName: true, lastName: true, email: true },
        }),
        prisma_1.default.counselorSession.findMany({
            where: { counselorId: profile.id, studentId, deletedAt: null },
            include: { studentFeedback: true, counselorFeedback: true },
            orderBy: { startTime: 'desc' },
        }),
        prisma_1.default.sessionNote.findMany({
            where: { counselorId: profile.id, studentId, deletedAt: null },
            orderBy: { createdAt: 'desc' },
        }),
    ]);
    (0, response_1.sendSuccess)(res, { student, sessions, notes });
});
/**
 * POST /api/v1/counselors/me/students/:studentId/send-email
 * Direct mailer tool
 */
router.post('/me/students/:studentId/send-email', async (req, res) => {
    const studentId = String(req.params.studentId);
    const { subject, message } = req.body;
    if (!subject || !message) {
        (0, response_1.sendError)(res, 'INVALID_INPUT', 'Subject and message are required', 400);
        return;
    }
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    if (!profile) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Profile not found', 404);
        return;
    }
    // Same scoping rule as the timeline route above. A plain findUnique on the id
    // let any counselor send a WellMindly-branded "message from your counselor" to
    // any user in the database - students they have never met, other counselors,
    // admins - as long as they knew a uuid.
    const student = await prisma_1.default.user.findFirst({
        where: {
            id: studentId,
            studentSessions: { some: { counselorId: profile.id, deletedAt: null } },
        },
    });
    if (!student) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Student not found', 404);
        return;
    }
    (0, emailQueue_1.queueEmail)({
        to: student.email,
        subject: `Message from your Counselor: ${subject}`,
        html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
        <h3 style="color: #4f46e5;">Message from WellMindly Counselor</h3>
        <p>Hello ${(0, escapeHtml_1.escapeHtml)(student.firstName)},</p>
        <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; margin: 16px 0; white-space: pre-wrap;">
          ${(0, escapeHtml_1.escapeHtml)(message)}
        </div>
      </div>
    `,
    });
    (0, auditLogger_1.logAuditEvent)({
        actorId: req.user?.sub || null,
        action: 'SEND_DIRECT_EMAIL_TO_STUDENT',
        targetEntity: 'User',
        targetId: studentId,
        details: { subject },
    });
    (0, response_1.sendSuccess)(res, { message: 'Email queued successfully' });
});
/**
 * POST /api/v1/counselors/me/sessions/:id/feedback
 * Submit counselor post-session evaluation
 */
router.post('/me/sessions/:id/feedback', async (req, res) => {
    const sessionId = String(req.params.id);
    const { rating, summaryNote, answers } = req.body;
    const profile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
    const session = await prisma_1.default.counselorSession.findUnique({ where: { id: sessionId } });
    if (!profile || !session) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Session or profile not found', 404);
        return;
    }
    // Same ownership rule as the notes endpoint above.
    if (session.counselorId !== profile.id) {
        (0, response_1.sendError)(res, 'NOT_FOUND', 'Session not found', 404);
        return;
    }
    // The student-facing feedback endpoint already validates this range; the
    // counselor side used to coerce with `rating || 5`, which turned a 0 into a 5
    // and let 99 through into the average the admin dashboard displays.
    if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
        (0, response_1.sendError)(res, 'INVALID_INPUT', 'Rating must be an integer between 1 and 5', 400);
        return;
    }
    // CounselorFeedback.sessionId is @unique, so a second submit for the same
    // session used to escape as an unhandled Prisma error - which Express served
    // as an HTML stack trace containing absolute file paths.
    const existing = await prisma_1.default.counselorFeedback.findUnique({ where: { sessionId } });
    if (existing) {
        (0, response_1.sendError)(res, 'ALREADY_EXISTS', 'Feedback has already been submitted for this session', 409);
        return;
    }
    const feedback = await prisma_1.default.counselorFeedback.create({
        data: {
            sessionId,
            counselorId: profile.id,
            studentId: session.studentId,
            rating: rating || 5,
            summaryNote: summaryNote || '',
            answers: answers || {},
        },
    });
    (0, response_1.sendSuccess)(res, feedback, 201);
});
exports.default = router;
