import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma';
import { signToken } from '../../lib/jwt';
import { env } from '../../config/env';
import { authenticateJWT, requireRoles, AuthenticatedRequest } from '../../middleware/rbac';
import { sendSuccess, sendError } from '../../utils/response';
import { queueEmail } from '../../utils/emailQueue';
import { sendEmail, getPasswordResetLinkTemplate } from '../../utils/mailer';
import { logAuditEvent } from '../../utils/auditLogger';
import { uploadToS3, getS3Object } from '../../utils/s3';
import { escapeHtml } from '../../utils/escapeHtml';
import { buildJitsiMeetingLink } from '../../utils/jitsi';
import { parseImageUpload, SAFE_IMAGE_MIME_TYPES } from '../../utils/imageUpload';

export function normalizeAvatarUrl(url?: string | null): string | null {
  if (!url) return null;
  if (url.includes('.amazonaws.com/')) {
    let key = url.split('.amazonaws.com/')[1];
    if (key) {
      key = key.split('?')[0];
      if (key.startsWith('wellmindly-assets/')) {
        key = key.replace(/^wellmindly-assets\//, '');
      }
      return `/api/v1/counselors/assets/${key}`;
    }
  }
  return url;
}

const router = Router();

/**
 * POST /api/v1/counselors/verify-invite
 * Check validity of counselor invitation token
 */
router.post('/verify-invite', async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };

  if (!token || typeof token !== 'string') {
    sendError(res, 'INVALID_INPUT', 'Invitation token is required', 400);
    return;
  }

  const invitation = await prisma.counselorInvitation.findUnique({
    where: { token },
  });

  if (!invitation || invitation.used || invitation.expiresAt < new Date()) {
    sendError(res, 'INVALID_INVITE', 'Invitation link is invalid or expired', 400);
    return;
  }

  sendSuccess(res, {
    email: invitation.email,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
  });
});

/**
 * POST /api/v1/counselors/setup-upload
 * Upload avatar during invitation onboarding using the invitation token
 */
router.post('/setup-upload', async (req: Request, res: Response) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      sendError(res, 'INVALID_INPUT', 'Invitation token is required', 400);
      return;
    }

    const invitation = await prisma.counselorInvitation.findUnique({
      where: { token },
    });

    if (!invitation || invitation.used || invitation.expiresAt < new Date()) {
      sendError(res, 'INVALID_INVITE', 'Invitation link is invalid or expired', 400);
      return;
    }

    const upload = parseImageUpload(req.body);
    if (!upload.ok) {
      sendError(res, 'INVALID_INPUT', upload.message, 400);
      return;
    }

    const result = await uploadToS3(upload.buffer, upload.fileName, upload.mimeType, upload.folder);

    sendSuccess(res, {
      message: 'File uploaded successfully',
      url: result.url,
      key: result.key,
    });
  } catch (error) {
    console.error('Error uploading setup file:', error);
    sendError(res, 'UPLOAD_FAILED', 'Failed to upload file', 500);
  }
});

/**
 * POST /api/v1/counselors/setup-profile
 * Complete password setup and create counselor account from invite token
 */
router.post('/setup-profile', async (req: Request, res: Response) => {
  const { token, password, credentials, specializations, bio, phone, timezone, avatarUrl } = req.body as {
    token?: string;
    password?: string;
    credentials?: string;
    specializations?: string[];
    bio?: string;
    phone?: string;
    timezone?: string;
    avatarUrl?: string;
  };

  if (!token || !password || !credentials) {
    sendError(res, 'INVALID_INPUT', 'Token, password, and credentials are required', 400);
    return;
  }

  if (typeof password !== 'string' || password.length < 8) {
    sendError(res, 'INVALID_INPUT', 'Password must be at least 8 characters long', 400);
    return;
  }

  const invitation = await prisma.counselorInvitation.findUnique({ where: { token } });
  if (!invitation || invitation.used || invitation.expiresAt < new Date()) {
    sendError(res, 'INVALID_INVITE', 'Invitation link is invalid or expired', 400);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // Transaction: Create user, create profile, mark invite used
  const user = await prisma.$transaction(async (tx) => {
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
        avatarUrl: avatarUrl ? normalizeAvatarUrl(avatarUrl) : null,
        status: 'ACTIVE',
      },
    });

    await tx.counselorInvitation.update({
      where: { id: invitation.id },
      data: { used: true },
    });

    return newUser;
  });

  const jwtToken = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    universityId: null,
  });

  logAuditEvent({
    actorId: user.id,
    action: 'REGISTER_COUNSELOR',
    targetEntity: 'User',
    targetId: user.id,
    ipAddress: req.ip || null,
  });

  sendSuccess(res, { token: jwtToken, user: { id: user.id, email: user.email, role: user.role } }, 201);
});

/**
 * POST /api/v1/counselors/login
 * Counselor Authentication
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    sendError(res, 'INVALID_INPUT', 'Email and password are required', 400);
    return;
  }

  // Lowercased like every other auth route; counselor emails are stored
  // lowercased (invite + /me/account), so a capitalised address typed on a
  // phone keyboard used to fail with "invalid email or password".
  const user = await prisma.user.findUnique({
    where: { email: typeof email === 'string' ? email.toLowerCase().trim() : '' },
    include: { counselorProfile: true },
  });

  if (!user || user.role !== 'COUNSELOR' || !user.passwordHash) {
    sendError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    return;
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    sendError(res, 'INVALID_CREDENTIALS', 'Invalid email or password', 401);
    return;
  }

  if (user.counselorProfile?.status === 'SUSPENDED') {
    sendError(res, 'ACCOUNT_SUSPENDED', 'Your counselor account is suspended', 403);
    return;
  }

  const token = signToken({
    sub: user.id,
    email: user.email,
    role: user.role,
    universityId: null,
  });

  sendSuccess(res, {
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

/**
 * POST /api/v1/counselors/forgot-password
 * Send password reset link to counselor email
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== 'string') {
    sendError(res, 'INVALID_INPUT', 'A valid email address is required', 400);
    return;
  }

  const emailLower = email.toLowerCase().trim();

  try {
    const user = await prisma.user.findUnique({
      where: { email: emailLower },
      include: { counselorProfile: true },
    });

    // One answer for "no such counselor", "suspended" and "sent": the old 404
    // told anyone which addresses belong to counselors.
    const genericMessage = 'If a counselor account exists for that email, a password reset link has been sent.';
    if (!user || user.role !== 'COUNSELOR' || user.counselorProfile?.status === 'SUSPENDED') {
      await new Promise((resolve) => setTimeout(resolve, 400 + Math.floor(Math.random() * 400)));
      sendSuccess(res, { message: genericMessage });
      return;
    }

    // Generate single-use signed reset token using secret salted with user's current password hash
    const resetSecret = `${env.JWT_SECRET}-${user.passwordHash || 'no-pwd'}`;
    const resetToken = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, purpose: 'counselor_reset_password' },
      resetSecret,
      { expiresIn: '1h' }
    );

    const counselorPortalUrl = env.COUNSELOR_PORTAL_URL.replace(/\/+$/, '');
    const resetUrl = `${counselorPortalUrl}/reset-password?token=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(user.email)}`;

    const delivered = await sendEmail({
      to: user.email,
      sensitive: true,
      subject: 'Reset Your Counselor Password - WellMindly',
      html: getPasswordResetLinkTemplate({
        name: user.firstName ? `${user.firstName} ${user.lastName}`.trim() : 'Counselor',
        resetLink: resetUrl,
        expiryMinutes: 60,
      }),
    });

    logAuditEvent({
      actorId: user.id,
      action: 'REQUEST_PASSWORD_RESET',
      targetEntity: 'User',
      targetId: user.id,
      ipAddress: req.ip || null,
    });

    if (!delivered) {
      sendError(res, 'EMAIL_UNAVAILABLE', 'We could not send a reset link right now. Please try again in a few minutes.', 503);
      return;
    }

    sendSuccess(res, { message: genericMessage });
  } catch (err: any) {
    console.error('Error processing counselor forgot-password:', err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to process password reset request. Please try again.', 500);
  }
});

/**
 * POST /api/v1/counselors/verify-reset-token
 * Verify if password reset token is valid and not expired
 */
router.post('/verify-reset-token', async (req: Request, res: Response) => {
  const { token, email } = req.body as { token?: string; email?: string };

  if (!token || typeof token !== 'string') {
    sendError(res, 'INVALID_INPUT', 'Reset token is required', 400);
    return;
  }

  try {
    let targetEmail = email ? email.toLowerCase().trim() : undefined;

    if (!targetEmail) {
      const decodedUnverified = jwt.decode(token) as { sub?: string; email?: string } | null;
      if (!decodedUnverified?.email && !decodedUnverified?.sub) {
        sendError(res, 'INVALID_TOKEN', 'Reset link is invalid or malformed', 400);
        return;
      }
      targetEmail = decodedUnverified.email?.toLowerCase().trim();
    }

    const user = targetEmail
      ? await prisma.user.findUnique({ where: { email: targetEmail } })
      : null;

    if (!user || user.role !== 'COUNSELOR') {
      sendError(res, 'INVALID_TOKEN', 'Reset link is invalid or associated counselor account was not found', 400);
      return;
    }

    const resetSecret = `${env.JWT_SECRET}-${user.passwordHash || 'no-pwd'}`;
    const decoded = jwt.verify(token, resetSecret) as { sub: string; email: string; purpose?: string };

    if (decoded.purpose !== 'counselor_reset_password') {
      sendError(res, 'INVALID_TOKEN', 'Reset link is invalid for password reset', 400);
      return;
    }

    sendSuccess(res, {
      valid: true,
      email: user.email,
      firstName: user.firstName,
    });
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') {
      sendError(res, 'TOKEN_EXPIRED', 'Password reset link has expired. Please request a new one.', 400);
      return;
    }
    sendError(res, 'INVALID_TOKEN', 'Reset link is invalid or has already been used.', 400);
  }
});

/**
 * POST /api/v1/counselors/reset-password
 * Complete password reset for counselor
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  const { token, newPassword, email } = req.body as {
    token?: string;
    newPassword?: string;
    email?: string;
  };

  if (!token || !newPassword) {
    sendError(res, 'INVALID_INPUT', 'Reset token and new password are required', 400);
    return;
  }

  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    sendError(res, 'INVALID_INPUT', 'New password must be at least 6 characters long', 400);
    return;
  }

  try {
    let targetEmail = email ? email.toLowerCase().trim() : undefined;

    if (!targetEmail) {
      const decodedUnverified = jwt.decode(token) as { sub?: string; email?: string } | null;
      if (!decodedUnverified?.email && !decodedUnverified?.sub) {
        sendError(res, 'INVALID_TOKEN', 'Reset link is invalid or malformed', 400);
        return;
      }
      targetEmail = decodedUnverified.email?.toLowerCase().trim();
    }

    const user = targetEmail
      ? await prisma.user.findUnique({ where: { email: targetEmail } })
      : null;

    if (!user || user.role !== 'COUNSELOR') {
      sendError(res, 'INVALID_TOKEN', 'Reset link is invalid or associated counselor account was not found', 400);
      return;
    }

    // Verify token using secret salted with current passwordHash
    const resetSecret = `${env.JWT_SECRET}-${user.passwordHash || 'no-pwd'}`;
    const decoded = jwt.verify(token, resetSecret) as { sub: string; email: string; purpose?: string };

    if (decoded.purpose !== 'counselor_reset_password') {
      sendError(res, 'INVALID_TOKEN', 'Reset link is invalid for password reset', 400);
      return;
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    logAuditEvent({
      actorId: user.id,
      action: 'RESET_PASSWORD',
      targetEntity: 'User',
      targetId: user.id,
      ipAddress: req.ip || null,
    });

    sendSuccess(res, {
      message: 'Password has been reset successfully. Please sign in with your new password.',
    });
  } catch (err: any) {
    if (err?.name === 'TokenExpiredError') {
      sendError(res, 'TOKEN_EXPIRED', 'Password reset link has expired. Please request a new one.', 400);
      return;
    }
    sendError(res, 'INVALID_TOKEN', 'Reset link is invalid or has already been used.', 400);
  }
});

/**
 * GET /api/v1/counselors/assets/:folder/:filename
 * Public proxy to stream avatars and counselor images without requiring authentication or public S3 bucket
 */
router.get('/assets/:folder/:filename', async (req: Request, res: Response) => {
  try {
    const rawFolder = Array.isArray(req.params.folder) ? req.params.folder[0] : req.params.folder;
    const rawFilename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
    const safeFolder = String(rawFolder || 'avatars').replace(/[^a-zA-Z0-9_-]/g, '');
    
    // Support URL-encoded names, spaces converted to underscores, and raw spaces
    const decodedFilename = decodeURIComponent(String(rawFilename || ''));
    const safeFilename = decodedFilename.replace(/[^a-zA-Z0-9._ -]/g, '');
    const underscoreFilename = safeFilename.replace(/\s+/g, '_');
    const strippedFilename = safeFilename.replace(/[^a-zA-Z0-9._-]/g, '');

    // Enable cross-origin embedding so any frontend (student, counselor, admin) can display images
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Belt and braces for anything uploaded before type checks existed: never
    // let a proxied asset execute script or be sniffed into HTML.
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const candidateFilenames = Array.from(new Set([
      safeFilename,
      underscoreFilename,
      strippedFilename,
    ])).filter(Boolean);

    // 1. Try local disk storage first (fast, reliable, works offline and in local dev)
    const candidateDirs = [
      path.join(process.cwd(), 'uploads', safeFolder),
      path.join(process.cwd(), 'backend', 'uploads', safeFolder),
      path.resolve(__dirname, '../../../uploads', safeFolder),
      path.resolve(__dirname, '../../uploads', safeFolder),
    ];

    for (const dir of candidateDirs) {
      for (const fname of candidateFilenames) {
        const localPath = path.join(dir, fname);
        if (fs.existsSync(localPath)) {
          const ext = path.extname(fname).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
          };
          // SVG is deliberately absent: an SVG served from the API origin can
          // run script. Unknown types go out as an opaque download.
          res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return fs.createReadStream(localPath).pipe(res);
        }
      }
    }

    // 2. Fetch from AWS S3 using server-side credentials
    for (const fname of candidateFilenames) {
      const key = `${safeFolder}/${fname}`;
      const s3Obj = await getS3Object(key);
      if (s3Obj && s3Obj.body) {
        // Trust the stored type only for raster images (see the local branch).
        const storedType = (s3Obj.contentType || '').toLowerCase();
        res.setHeader('Content-Type', SAFE_IMAGE_MIME_TYPES.has(storedType) ? storedType : 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h

        if (typeof s3Obj.body.pipe === 'function') {
          return s3Obj.body.pipe(res);
        } else {
          const bytes = await s3Obj.body.transformToByteArray();
          return res.send(Buffer.from(bytes));
        }
      }
    }

    res.status(404).send('Asset not found');
  } catch (err) {
    console.error('Error proxying asset:', err);
    res.status(500).send('Failed to fetch asset');
  }
});

// Protected routes below
router.use(authenticateJWT, requireRoles(['COUNSELOR', 'ADMIN', 'SUPER_ADMIN']));

/**
 * GET /api/v1/counselors/me/profile
 */
router.get('/me/profile', async (req: AuthenticatedRequest, res: Response) => {
  const profile = await prisma.counselorProfile.findUnique({
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
    sendError(res, 'NOT_FOUND', 'Counselor profile not found', 404);
    return;
  }

  profile.avatarUrl = normalizeAvatarUrl(profile.avatarUrl);
  sendSuccess(res, profile);
});

/**
 * PUT /api/v1/counselors/me/profile
 */
router.put('/me/profile', async (req: AuthenticatedRequest, res: Response) => {
  const { specializations, credentials, bio, phone, avatarUrl, timezone } = req.body as {
    specializations?: string[];
    credentials?: string;
    bio?: string | null;
    phone?: string | null;
    avatarUrl?: string | null;
    timezone?: string | null;
  };

  const optionalString = (v: unknown) => v === undefined || v === null || typeof v === 'string';
  if (
    (specializations !== undefined && (!Array.isArray(specializations) || specializations.some((s: unknown) => typeof s !== 'string'))) ||
    (credentials !== undefined && typeof credentials !== 'string') || !optionalString(bio) || !optionalString(phone) ||
    !optionalString(avatarUrl) || !optionalString(timezone)
  ) {
    sendError(res, 'INVALID_INPUT', 'Invalid profile fields', 400);
    return;
  }

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Counselor profile not found', 404);
    return;
  }

  if (timezone) {
    await prisma.user.update({
      where: { id: req.user?.sub },
      data: { timezone },
    });
  }

  const updatedProfile = await prisma.counselorProfile.update({
    where: { id: profile.id },
    data: {
      specializations,
      credentials,
      bio,
      phone,
      avatarUrl,
    },
    // Not `user: true`: that returned the counselor's own passwordHash and googleId.
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true, timezone: true } } },
  });

  updatedProfile.avatarUrl = normalizeAvatarUrl(updatedProfile.avatarUrl);
  sendSuccess(res, updatedProfile);
});

/**
 * POST /api/v1/counselors/me/upload
 * Upload profile picture to AWS S3 bucket wellmindly-assets (us-east-1)
 */
router.post('/me/upload', authenticateJWT, requireRoles(['COUNSELOR', 'ADMIN', 'SUPER_ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const upload = parseImageUpload(req.body);
    if (!upload.ok) {
      sendError(res, 'INVALID_INPUT', upload.message, 400);
      return;
    }

    const result = await uploadToS3(upload.buffer, upload.fileName, upload.mimeType, upload.folder);

    const userId = req.user?.sub;
    if (userId) {
      await prisma.counselorProfile.updateMany({
        where: { userId },
        data: { avatarUrl: result.url },
      });
    }

    sendSuccess(res, {
      message: 'File uploaded successfully',
      url: result.url,
      key: result.key,
    });
  } catch (error) {
    console.error('Error uploading file to S3:', error);
    sendError(res, 'UPLOAD_FAILED', 'Failed to upload file to S3', 500);
  }
});

/**
 * PUT /api/v1/counselors/me/account
 * Update email and/or password for counselor account
 */
router.put('/me/account', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      sendError(res, 'UNAUTHORIZED', 'Unauthorized', 401);
      return;
    }

    const { email, currentPassword, newPassword } = req.body as {
      email?: string;
      currentPassword?: string;
      newPassword?: string;
    };

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      sendError(res, 'NOT_FOUND', 'User not found', 404);
      return;
    }

    const updateData: { email?: string; passwordHash?: string } = {};

    // 1. Update Email
    if (email && email.trim().toLowerCase() !== user.email.toLowerCase()) {
      const cleanEmail = email.trim().toLowerCase();
      const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
      if (existing) {
        sendError(res, 'EMAIL_TAKEN', 'This email address is already in use by another user.', 400);
        return;
      }
      updateData.email = cleanEmail;
    }

    // 2. Update Password
    if (newPassword) {
      if (!currentPassword) {
        sendError(res, 'INVALID_INPUT', 'Current password is required to set a new password.', 400);
        return;
      }
      if (user.passwordHash) {
        const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!isValid) {
          sendError(res, 'INVALID_CREDENTIALS', 'Current password entered is incorrect.', 400);
          return;
        }
      }
      if (newPassword.length < 6) {
        sendError(res, 'INVALID_INPUT', 'New password must be at least 6 characters long.', 400);
        return;
      }
      updateData.passwordHash = await bcrypt.hash(newPassword, 10);
    }

    if (Object.keys(updateData).length === 0) {
      sendError(res, 'INVALID_INPUT', 'No account fields were changed.', 400);
      return;
    }

    const updatedUser = await prisma.user.update({
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

    logAuditEvent({
      actorId: userId,
      action: 'UPDATE_COUNSELOR_ACCOUNT',
      targetEntity: 'User',
      targetId: userId,
      details: { updatedEmail: !!updateData.email, updatedPassword: !!updateData.passwordHash },
    });

    sendSuccess(res, { user: updatedUser, message: 'Account credentials updated successfully.' });
  } catch (err: any) {
    console.error('Error updating counselor account:', err);
    sendError(res, 'INTERNAL_ERROR', 'Failed to update account credentials', 500);
  }
});

/**
 * GET /api/v1/counselors/me/exceptions
 * Fetch date-specific blocked hours
 */
router.get('/me/exceptions', async (req: AuthenticatedRequest, res: Response) => {
  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  const exceptions = await prisma.counselorAvailabilityException.findMany({
    where: { counselorId: profile.id },
    orderBy: { startDate: 'asc' },
  });

  sendSuccess(res, exceptions);
});

/**
 * POST /api/v1/counselors/me/exceptions
 * Block specific date/time hours
 */
router.post('/me/exceptions', async (req: AuthenticatedRequest, res: Response) => {
  const { startDate, endDate, reason, isFullDay } = req.body as {
    startDate?: string;
    endDate?: string;
    reason?: string;
    isFullDay?: boolean;
  };

  if (!startDate || !endDate) {
    sendError(res, 'INVALID_INPUT', 'startDate and endDate are required', 400);
    return;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    sendError(res, 'INVALID_INPUT', 'startDate and endDate must be valid dates, with endDate after startDate', 400);
    return;
  }

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  const exception = await prisma.counselorAvailabilityException.create({
    data: {
      counselorId: profile.id,
      startDate: start,
      endDate: end,
      isFullDay: isFullDay ?? false,
      reason: reason || 'Blocked by Counselor',
    },
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'BLOCK_COUNSELOR_HOURS',
    targetEntity: 'CounselorAvailabilityException',
    targetId: exception.id,
    details: { startDate, endDate, reason },
  });

  sendSuccess(res, exception, 201);
});

/**
 * DELETE /api/v1/counselors/me/exceptions/:id
 * Unblock hours
 */
router.delete('/me/exceptions/:id', async (req: AuthenticatedRequest, res: Response) => {
  const id = String(req.params.id);
  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  await prisma.counselorAvailabilityException.deleteMany({
    where: { id, counselorId: profile.id },
  });

  sendSuccess(res, { message: 'Blockout removed successfully' });
});

/**
 * PUT /api/v1/counselors/me/availability
 * Replace weekly availability rules
 */
router.put('/me/availability', async (req: AuthenticatedRequest, res: Response) => {
  const { availabilities } = req.body as {
    availabilities?: { dayOfWeek: number; startTime: string; endTime: string }[];
  };

  // Validate before the delete-then-insert below, so a bad row is a 400 and
  // not a 500 halfway through replacing the counselor's schedule.
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (
    availabilities !== undefined &&
    (!Array.isArray(availabilities) ||
      availabilities.some(
        (a) =>
          !a ||
          !Number.isInteger(a.dayOfWeek) ||
          a.dayOfWeek < 0 ||
          a.dayOfWeek > 6 ||
          typeof a.startTime !== 'string' ||
          typeof a.endTime !== 'string' ||
          !HHMM.test(a.startTime) ||
          !HHMM.test(a.endTime) ||
          a.endTime <= a.startTime
      ))
  ) {
    sendError(res, 'INVALID_INPUT', 'Each availability needs dayOfWeek 0-6 and HH:MM startTime before endTime', 400);
    return;
  }

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  await prisma.$transaction(async (tx) => {
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

  const updated = await prisma.counselorAvailability.findMany({
    where: { counselorId: profile.id },
  });

  sendSuccess(res, updated);
});

/**
 * GET /api/v1/counselors/me/sessions
 */
router.get('/me/sessions', async (req: AuthenticatedRequest, res: Response) => {
  const profile = await prisma.counselorProfile.findUnique({
    where: { userId: req.user?.sub },
    include: { user: true },
  });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  const sessions = await prisma.counselorSession.findMany({
    where: { counselorId: profile.id, deletedAt: null },
    include: {
      student: { select: { id: true, firstName: true, lastName: true, email: true } },
      notes: true,
      studentFeedback: true,
      counselorFeedback: true,
    },
    orderBy: { startTime: 'desc' },
  });

  const enrichedSessions = sessions.map((s) => ({
    ...s,
    meetingLink: profile.user
      ? buildJitsiMeetingLink({
          baseLink: s.meetingLink,
          user: profile.user,
          isModerator: true,
        })
      : s.meetingLink,
  }));

  sendSuccess(res, enrichedSessions);
});

/**
 * POST /api/v1/counselors/me/sessions/:id/notes
 * Add or update session note
 */
router.post('/me/sessions/:id/notes', async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = String(req.params.id);
  const { title, content, isPrivate, isDraft } = req.body as {
    title?: string;
    content?: string;
    isPrivate?: boolean;
    isDraft?: boolean;
  };

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  const session = await prisma.counselorSession.findUnique({ where: { id: sessionId } });

  if (!profile || !session) {
    sendError(res, 'NOT_FOUND', 'Session or profile not found', 404);
    return;
  }

  // A note may only be written against the counselor's own session. Without this
  // check any counselor could write into another counselor's clinical record,
  // and the note would then surface in their own student timeline view.
  if (session.counselorId !== profile.id) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  const note = await prisma.sessionNote.create({
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

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'CREATE_SESSION_NOTE',
    targetEntity: 'SessionNote',
    targetId: note.id,
  });

  sendSuccess(res, note, 201);
});

const CANCELLED_STATUSES: string[] = ['CANCELLED_BY_STUDENT', 'CANCELLED_BY_COUNSELOR', 'EXPIRED'];

/**
 * PUT /api/v1/counselors/me/sessions/:id/notes/:noteId
 * Edit a draft note, or finalise it with { isDraft: false }. Only the note's
 * own counselor may edit it, and only while it is still a draft: a finalised
 * note is part of the clinical record and is immutable (409).
 * Body: { title?: string, content?: string, isPrivate?: boolean, isDraft?: boolean }
 */
router.put('/me/sessions/:id/notes/:noteId', async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = String(req.params.id);
  const noteId = String(req.params.noteId);
  const { title, content, isPrivate, isDraft } = req.body as {
    title?: unknown;
    content?: unknown;
    isPrivate?: unknown;
    isDraft?: unknown;
  };

  if (
    (title !== undefined && typeof title !== 'string') ||
    (content !== undefined && typeof content !== 'string') ||
    (isPrivate !== undefined && typeof isPrivate !== 'boolean') ||
    (isDraft !== undefined && typeof isDraft !== 'boolean')
  ) {
    sendError(res, 'INVALID_INPUT', 'title/content must be strings and isPrivate/isDraft booleans', 400);
    return;
  }

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  const note = await prisma.sessionNote.findFirst({
    where: { id: noteId, sessionId, counselorId: profile.id, deletedAt: null },
  });
  if (!note) {
    sendError(res, 'NOT_FOUND', 'Note not found', 404);
    return;
  }
  if (!note.isDraft) {
    sendError(res, 'NOTE_FINALISED', 'This note has been finalised and can no longer be edited', 409);
    return;
  }

  const updated = await prisma.sessionNote.update({
    where: { id: note.id },
    data: {
      ...(title !== undefined ? { title: title as string } : {}),
      ...(content !== undefined ? { content: content as string } : {}),
      ...(isPrivate !== undefined ? { isPrivate: isPrivate as boolean } : {}),
      ...(isDraft !== undefined ? { isDraft: isDraft as boolean } : {}),
    },
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: updated.isDraft ? 'UPDATE_SESSION_NOTE_DRAFT' : 'FINALISE_SESSION_NOTE',
    targetEntity: 'SessionNote',
    targetId: updated.id,
  });

  sendSuccess(res, updated);
});

/**
 * PATCH /api/v1/counselors/me/sessions/:id/status
 * The session's own counselor moves it on. Body: { status, reason? }
 *   CONFIRMED | IN_PROGRESS -> COMPLETED            (only once the start time has passed)
 *   CONFIRMED               -> NO_SHOW              (only once the start time has passed)
 *   PENDING | CONFIRMED     -> CANCELLED_BY_COUNSELOR (only before the session ends; student is emailed)
 * Anything else is 409 INVALID_TRANSITION.
 */
router.patch('/me/sessions/:id/status', async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = String(req.params.id);
  const { status, reason } = req.body as { status?: unknown; reason?: unknown };

  const transitions: Record<string, string[]> = {
    COMPLETED: ['CONFIRMED', 'IN_PROGRESS'],
    NO_SHOW: ['CONFIRMED'],
    CANCELLED_BY_COUNSELOR: ['PENDING', 'CONFIRMED'],
  };

  if (typeof status !== 'string' || !transitions[status]) {
    sendError(res, 'INVALID_INPUT', `status must be one of ${Object.keys(transitions).join(', ')}`, 400);
    return;
  }
  if (reason !== undefined && typeof reason !== 'string') {
    sendError(res, 'INVALID_INPUT', 'reason must be a string', 400);
    return;
  }

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub }, include: { user: true } });
  const session = await prisma.counselorSession.findFirst({
    where: { id: sessionId, deletedAt: null },
    include: { student: { select: { email: true, firstName: true } } },
  });

  // Another counselor's session is reported as missing, as on the notes route.
  if (!profile || !session || session.counselorId !== profile.id) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  if (!transitions[status].includes(session.status)) {
    sendError(res, 'INVALID_TRANSITION', `A ${session.status} session cannot be marked ${status}`, 409);
    return;
  }

  const now = Date.now();
  if ((status === 'COMPLETED' || status === 'NO_SHOW') && session.startTime.getTime() > now) {
    sendError(res, 'SESSION_NOT_STARTED', 'A session can only be marked completed or no-show after it has started', 409);
    return;
  }
  if (status === 'CANCELLED_BY_COUNSELOR' && session.endTime.getTime() <= now) {
    sendError(res, 'SESSION_ENDED', 'A session that has already ended cannot be cancelled', 409);
    return;
  }

  // Optimistic lock on the status we validated against, so two quick clicks
  // (or a student cancelling at the same moment) cannot both win.
  const result = await prisma.counselorSession.updateMany({
    where: { id: session.id, status: session.status },
    data: {
      status: status as any,
      ...(status === 'CANCELLED_BY_COUNSELOR'
        ? { cancellationReason: (reason as string | undefined)?.trim() || 'Cancelled by counselor' }
        : {}),
      version: { increment: 1 },
    },
  });
  if (result.count === 0) {
    sendError(res, 'CONFLICT', 'The session was changed by someone else. Please refresh and try again.', 409);
    return;
  }

  const updated = await prisma.counselorSession.findUnique({ where: { id: session.id } });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'UPDATE_SESSION_STATUS_BY_COUNSELOR',
    targetEntity: 'CounselorSession',
    targetId: session.id,
    details: { from: session.status, to: status },
  });

  if (status === 'CANCELLED_BY_COUNSELOR') {
    const formattedTime = session.startTime.toUTCString();
    queueEmail({
      to: session.student.email,
      subject: `Cancelled: Counseling Session on ${formattedTime}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">Counseling Session Cancelled</h2>
          <p>Hello <strong>${escapeHtml(session.student.firstName)}</strong>,</p>
          <p>Your session with <strong>${escapeHtml(profile.user.firstName)} ${escapeHtml(profile.user.lastName)}</strong> on ${formattedTime} (UTC) has been cancelled by your counselor.</p>
          <p style="margin: 4px 0;"><strong>Reason:</strong> ${escapeHtml(updated?.cancellationReason || 'Cancelled by counselor')}</p>
          <p style="color: #64748b; font-size: 14px;">You can book another session whenever you are ready.</p>
        </div>
      `,
    });
  }

  sendSuccess(res, updated);
});

/**
 * GET /api/v1/counselors/me/students/:studentId/timeline
 * Student historical timeline (notes, sessions, feedback)
 */
router.get('/me/students/:studentId/timeline', async (req: AuthenticatedRequest, res: Response) => {
  const studentId = String(req.params.studentId);
  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });

  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  const [student, sessions, notes] = await Promise.all([
    // Scoped to a student this counselor actually has a session or a note with.
    // A plain findUnique on studentId turned this route into a lookup for any
    // user's name and email by uuid.
    prisma.user.findFirst({
      where: {
        id: studentId,
        studentSessions: { some: { counselorId: profile.id, deletedAt: null } },
      },
      select: { id: true, firstName: true, lastName: true, email: true },
    }),
    prisma.counselorSession.findMany({
      where: { counselorId: profile.id, studentId, deletedAt: null },
      include: { studentFeedback: true, counselorFeedback: true },
      orderBy: { startTime: 'desc' },
    }),
    prisma.sessionNote.findMany({
      where: { counselorId: profile.id, studentId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  sendSuccess(res, { student, sessions, notes });
});

/**
 * POST /api/v1/counselors/me/students/:studentId/send-email
 * Direct mailer tool
 */
router.post('/me/students/:studentId/send-email', async (req: AuthenticatedRequest, res: Response) => {
  const studentId = String(req.params.studentId);
  const { subject, message } = req.body as { subject?: string; message?: string };

  if (!subject || !message) {
    sendError(res, 'INVALID_INPUT', 'Subject and message are required', 400);
    return;
  }

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  if (!profile) {
    sendError(res, 'NOT_FOUND', 'Profile not found', 404);
    return;
  }

  // Same scoping rule as the timeline route above. A plain findUnique on the id
  // let any counselor send a WellMindly-branded "message from your counselor" to
  // any user in the database - students they have never met, other counselors,
  // admins - as long as they knew a uuid.
  const student = await prisma.user.findFirst({
    where: {
      id: studentId,
      studentSessions: { some: { counselorId: profile.id, deletedAt: null } },
    },
  });
  if (!student) {
    sendError(res, 'NOT_FOUND', 'Student not found', 404);
    return;
  }

  queueEmail({
    to: student.email,
    subject: `Message from your Counselor: ${subject}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
        <h3 style="color: #4f46e5;">Message from WellMindly Counselor</h3>
        <p>Hello ${escapeHtml(student.firstName)},</p>
        <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; margin: 16px 0; white-space: pre-wrap;">
          ${escapeHtml(message)}
        </div>
      </div>
    `,
  });

  logAuditEvent({
    actorId: req.user?.sub || null,
    action: 'SEND_DIRECT_EMAIL_TO_STUDENT',
    targetEntity: 'User',
    targetId: studentId,
    details: { subject },
  });

  sendSuccess(res, { message: 'Email queued successfully' });
});

/**
 * POST /api/v1/counselors/me/sessions/:id/feedback
 * Submit counselor post-session evaluation
 */
router.post('/me/sessions/:id/feedback', async (req: AuthenticatedRequest, res: Response) => {
  const sessionId = String(req.params.id);
  const { rating, summaryNote, answers } = req.body as {
    rating?: number;
    summaryNote?: string;
    answers?: any;
  };

  const profile = await prisma.counselorProfile.findUnique({ where: { userId: req.user?.sub } });
  const session = await prisma.counselorSession.findUnique({ where: { id: sessionId } });

  if (!profile || !session) {
    sendError(res, 'NOT_FOUND', 'Session or profile not found', 404);
    return;
  }

  // Same ownership rule as the notes endpoint above.
  if (session.counselorId !== profile.id) {
    sendError(res, 'NOT_FOUND', 'Session not found', 404);
    return;
  }

  if (session.startTime.getTime() > Date.now() || CANCELLED_STATUSES.includes(session.status)) {
    sendError(res, 'SESSION_NOT_ELIGIBLE', 'Feedback can only be given for a session that has taken place', 400);
    return;
  }

  // The student-facing feedback endpoint already validates this range; the
  // counselor side used to coerce with `rating || 5`, which turned a 0 into a 5
  // and let 99 through into the average the admin dashboard displays.
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    sendError(res, 'INVALID_INPUT', 'Rating must be an integer between 1 and 5', 400);
    return;
  }

  // CounselorFeedback.sessionId is @unique, so a second submit for the same
  // session used to escape as an unhandled Prisma error - which Express served
  // as an HTML stack trace containing absolute file paths.
  const existing = await prisma.counselorFeedback.findUnique({ where: { sessionId } });
  if (existing) {
    sendError(res, 'ALREADY_EXISTS', 'Feedback has already been submitted for this session', 409);
    return;
  }

  const feedback = await prisma.counselorFeedback.create({
    data: {
      sessionId,
      counselorId: profile.id,
      studentId: session.studentId,
      rating: rating || 5,
      summaryNote: summaryNote || '',
      answers: answers || {},
    },
  });

  sendSuccess(res, feedback, 201);
});

export default router;
