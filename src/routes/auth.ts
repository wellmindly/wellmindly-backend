import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import prisma from '../lib/prisma';
import { signToken } from '../lib/jwt';
import { env } from '../config/env';
import { sendEmail, getOtpTemplate, getAccountDeletedTemplate } from '../utils/mailer';
import { authenticateJWT } from '../utils/jwt';
import { isStudentEligible } from '../services/accessControl';

const router = Router();
const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

// Every OAuth client ID whose ID tokens we accept. Web and native (Android
// Credential Manager) sign-in both mint tokens for the *web* client ID, so
// GOOGLE_CLIENT_ID alone is normally enough; GOOGLE_CLIENT_IDS lets an extra
// client (e.g. iOS) be added without a code change.
const googleAudiences = Array.from(
  new Set(
    [env.GOOGLE_CLIENT_ID, ...(env.GOOGLE_CLIENT_IDS || '').split(',')]
      .map((id) => (id || '').trim())
      .filter(Boolean)
  )
);

/**
 * POST /api/auth/google/callback
 *
 * Accepts a Google ID token from the frontend (sent after Google Sign-In),
 * validates it, checks university domain membership, and issues a JWT.
 *
 * Body: { idToken: string }
 */
router.post('/google/callback', async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body as { idToken?: string };

    if (!idToken) {
      res.status(400).json({ error: 'idToken is required' });
      return;
    }

    if (googleAudiences.length === 0) {
      console.error('Google sign-in rejected: GOOGLE_CLIENT_ID is not configured on the server.');
      res.status(503).json({ error: 'Google sign-in is not configured' });
      return;
    }

    // The signature, issuer, expiry and audience must all verify. Never fall
    // back to an unverified decode: that lets anyone mint a token for any email.
    let payload: TokenPayload | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: googleAudiences });
      payload = ticket.getPayload();
    } catch (err: any) {
      console.warn('Google ID token verification failed:', err?.message || err);
      res.status(401).json({ error: 'Invalid or expired Google token' });
      return;
    }

    if (!payload || !payload.email) {
      res.status(401).json({ error: 'Google token payload is missing email' });
      return;
    }
    if (payload.email_verified === false) {
      res.status(401).json({ error: 'Your Google email address is not verified' });
      return;
    }

    const { sub: googleId, email, given_name: firstName = '', family_name: lastName = '' } = payload;
    const emailLower = email.toLowerCase().trim();

    // 2. Extract domain from email and find matching university
    const domain = emailLower.split('@')[1];
    let university = null;
    if (domain) {
      university = await prisma.university.findFirst({
        where: { domain: { equals: domain, mode: 'insensitive' } },
      });
    }

    // 3. Upsert the user: create on first login, find on subsequent logins
    const user = await prisma.user.upsert({
      where: { email: emailLower },
      update: {
        googleId,
        ...(university ? { universityId: university.id } : {}),
      },
      create: {
        email: emailLower,
        googleId,
        firstName,
        lastName,
        role: 'STUDENT',
        universityId: university?.id ?? null,
      },
    });

    // 4. Issue a structured JWT
    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      universityId: user.universityId,
    });

    const eligibility = await isStudentEligible(emailLower);
    const isVerified = eligibility.eligible || (university?.verified ?? false);

    res.status(200).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        universityId: user.universityId,
        universityDomain: university?.domain ?? eligibility.domain ?? null,
        universityVerified: isVerified,
      },
      eligibility,
    });

  } catch (error: any) {
    console.error('Error in /api/auth/google/callback:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

interface OtpEntry {
  code: string;
  expiresAt: number;
  // Wrong guesses against this code so far. A 6-digit code is only safe if the
  // number of guesses is bounded per code, not just per IP: the reset and
  // delete endpoints otherwise let a distributed attacker walk the whole code
  // space inside the expiry window and take over (or erase) any account.
  attempts?: number;
}

const MAX_OTP_ATTEMPTS = 5;

function generateOtpCode(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

type OtpCheck = 'OK' | 'MISSING' | 'EXPIRED' | 'MISMATCH' | 'LOCKED';

/**
 * Checks a submitted code against the stored one. Expired codes and codes that
 * have had MAX_OTP_ATTEMPTS wrong guesses are deleted, so the caller has to
 * request a fresh code. Does not delete on success; the caller does that once
 * the protected action has actually happened.
 */
function checkOtp(store: Map<string, OtpEntry>, key: string, submitted: unknown): OtpCheck {
  const entry = store.get(key);
  if (!entry) return 'MISSING';
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return 'EXPIRED';
  }
  const candidate = typeof submitted === 'string' ? submitted.trim() : String(submitted ?? '');
  const a = Buffer.from(candidate);
  const b = Buffer.from(entry.code);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'OK';

  entry.attempts = (entry.attempts ?? 0) + 1;
  if (entry.attempts >= MAX_OTP_ATTEMPTS) {
    store.delete(key);
    return 'LOCKED';
  }
  return 'MISMATCH';
}

const OTP_ERRORS: Record<Exclude<OtpCheck, 'OK'>, string> = {
  MISSING: 'Please request a verification code first',
  EXPIRED: 'Verification code has expired',
  MISMATCH: 'Incorrect verification code',
  LOCKED: 'Too many incorrect attempts. Please request a new verification code.',
};

const otpStore = new Map<string, OtpEntry>();

/**
 * POST /api/auth/send-otp
 *
 * Generates and sends a 6-digit verification code to the user's email.
 */
router.post('/send-otp', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const emailLower = email.toLowerCase().trim();

  // 1. Check if email is already registered
  const existingUser = await prisma.user.findUnique({
    where: { email: emailLower },
  });

  if (existingUser) {
    res.status(400).json({ error: 'Email address is already registered. Please sign in instead.' });
    return;
  }

  const code = generateOtpCode();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiration

  otpStore.set(emailLower, { code, expiresAt });

  try {
    const delivered = await sendEmail({
      to: emailLower,
      sensitive: true,
      subject: 'Verify Your Account - WellMindly',
      html: getOtpTemplate(code, 'register'),
    });
    if (!delivered) {
      // No provider accepted the mail. Saying "code sent" here left people
      // waiting for an email that was never going to arrive.
      res.status(503).json({ error: 'We could not send a verification code right now. Please try again in a few minutes.' });
      return;
    }
    res.status(200).json({ message: 'Verification code sent to your email.' });
  } catch (err) {
    console.error('Error sending sign-up OTP:', err);
    res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
  }
});

/**
 * POST /api/auth/forgot-password
 *
 * Generates and sends a 6-digit OTP code to the user for resetting their password.
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const emailLower = email.toLowerCase().trim();

  // Same answer whether or not the address has an account; "Email address not
  // found" let anyone test which addresses are registered (for a mental-health
  // service, that is itself sensitive). The unknown-address branch waits about
  // as long as a real send so the response time does not give it away either.
  const genericMessage = 'If an account exists for that email, a password reset code has been sent.';

  try {
    const user = await prisma.user.findUnique({
      where: { email: emailLower },
    });

    if (!user) {
      await new Promise((resolve) => setTimeout(resolve, 400 + crypto.randomInt(0, 400)));
      res.status(200).json({ message: genericMessage });
      return;
    }

    const code = generateOtpCode();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiration

    otpStore.set(emailLower, { code, expiresAt });

    const delivered = await sendEmail({
      to: emailLower,
      sensitive: true,
      subject: 'Reset Your Password - WellMindly',
      html: getOtpTemplate(code, 'forgot_password'),
    });

    if (!delivered) {
      res.status(503).json({ error: 'We could not send a reset code right now. Please try again in a few minutes.' });
      return;
    }

    res.status(200).json({ message: genericMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process forgot password. Please try again.' });
  }
});

/**
 * POST /api/auth/reset-password
 *
 * Resets password using the received OTP code.
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  const { email, otp, newPassword, role } = req.body;

  if (!email || !otp || !newPassword || typeof email !== 'string') {
    res.status(400).json({ error: 'Email, verification code, and new password are required' });
    return;
  }

  const emailLower = email.toLowerCase().trim();

  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters long' });
    return;
  }

  const otpResult = checkOtp(otpStore, emailLower, otp);
  if (otpResult !== 'OK') {
    res.status(400).json({ error: OTP_ERRORS[otpResult] });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: emailLower },
    });

    if (!user) {
      res.status(400).json({ error: 'User not found' });
      return;
    }

    if (role && user.role !== role) {
      res.status(403).json({ error: 'Unauthorized role reset' });
      return;
    }

    const bcrypt = require('bcrypt');
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(newPassword, saltRounds);

    await prisma.user.update({
      where: { email: emailLower },
      data: { passwordHash },
    });

    // Clear OTP on successful reset
    otpStore.delete(emailLower);

    res.status(200).json({ message: 'Password has been reset successfully.' });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

/**
 * POST /api/auth/login
 *
 * Traditional email/password login for Admins and University Staff.
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = typeof email === 'string' ? email.toLowerCase().trim() : '';

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      include: { university: true },
    });

    if (!user || !user.passwordHash) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Validate password
    const bcrypt = require('bcrypt'); // require dynamically or add to top
    const isValid = await bcrypt.compare(password, user.passwordHash);

    if (!isValid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Optional: Ensure the requested role matches their profile
    if (role && user.role !== role) {
      res.status(403).json({ error: 'Unauthorized role access' });
      return;
    }

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      universityId: user.universityId,
    });

    const eligibility = await isStudentEligible(user.email);
    const isVerified = eligibility.eligible || (user.university?.verified ?? false);

    res.status(200).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        universityId: user.universityId,
        universityDomain: user.university?.domain ?? eligibility.domain ?? null,
        universityVerified: isVerified,
      },
      eligibility,
    });
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Authentication error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/auth/register
 *
 * Traditional email/password registration for Students.
 */
router.post('/register', async (req: Request, res: Response) => {
  const { email, password, firstName, lastName, otp } = req.body;

  if (!email || !password || !firstName || !lastName || !otp) {
    res.status(400).json({ error: 'All fields are required' });
    return;
  }

  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Invalid email or password' });
    return;
  }

  // Stored and looked up lowercased, exactly as /login and /send-otp do. The
  // raw value used to be saved as typed, so "Alice@Uni.edu" registered fine
  // and then could never sign in, because /login lowercases before lookup.
  const emailLower = email.toLowerCase().trim();
  const domain = emailLower.split('@')[1];
  if (!domain) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters long' });
    return;
  }

  // Validate OTP
  const otpResult = checkOtp(otpStore, emailLower, otp);
  if (otpResult !== 'OK') {
    res.status(400).json({ error: OTP_ERRORS[otpResult] });
    return;
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email: emailLower },
    });

    if (existingUser) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    const university = await prisma.university.findUnique({
      where: { domain },
    });

    const bcrypt = require('bcrypt');
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const user = await prisma.user.create({
      data: {
        email: emailLower,
        passwordHash,
        firstName,
        lastName,
        role: 'STUDENT',
        universityId: university?.id ?? null,
      },
    });

    // Clear OTP on successful signup
    otpStore.delete(emailLower);

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      universityId: user.universityId,
    });

    const eligibility = await isStudentEligible(emailLower);
    const isVerified = eligibility.eligible || (university?.verified ?? false);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        universityId: user.universityId,
        universityDomain: university?.domain ?? eligibility.domain ?? null,
        universityVerified: isVerified,
      },
      eligibility,
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

/**
 * GET /api/auth/me
 *
 * Returns current authenticated user and live up-to-date eligibility status.
 */
router.get('/me', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    const email = req.user?.email;

    if (!userId && !email) {
      res.status(401).json({ error: 'Unauthorized: missing user identity' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(userId ? [{ id: userId }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
      include: { university: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const eligibility = await isStudentEligible(user.email);
    const isVerified = eligibility.eligible || (user.university?.verified ?? false);

    res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        universityId: user.universityId,
        universityDomain: user.university?.domain ?? eligibility.domain ?? null,
        universityVerified: isVerified,
      },
      eligibility,
    });
  } catch (err: any) {
    console.error('Error in /api/auth/me:', err);
    res.status(500).json({ error: 'Failed to fetch current user' });
  }
});


/**
 * POST /api/auth/waitlist
 *
 * Adds an email and feature to the waitlist.
 * Body: { email: string, feature: string }
 */
router.post('/waitlist', async (req: Request, res: Response) => {
  const { email, feature } = req.body as { email?: string; feature?: string };

  if (!email || !feature || typeof email !== 'string' || typeof feature !== 'string') {
    res.status(400).json({ error: 'Email and feature are required' });
    return;
  }

  const emailLower = email.toLowerCase().trim();
  if (!emailLower.includes('@')) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  try {
    const waitlistEntry = await prisma.waitlist.upsert({
      where: {
        email_feature: {
          email: emailLower,
          feature,
        },
      },
      update: {}, // No-op if it already exists
      create: {
        email: emailLower,
        feature,
      },
    });

    res.status(200).json({
      message: 'Successfully joined the waitlist.',
      waitlist: waitlistEntry,
    });
  } catch (err: any) {
    console.error('Waitlist error:', err);
    res.status(500).json({ error: 'Failed to join waitlist. Please try again.' });
  }
});

const deleteOtpStore = new Map<string, OtpEntry>();

async function deleteUserAndAssociatedData(userId: string) {
  // 1. Delete student counselor sessions
  await prisma.counselorSession.deleteMany({
    where: { studentId: userId },
  });

  // 2. Unassign audit logs to preserve audit chain without orphan FK
  await prisma.auditLog.updateMany({
    where: { actorId: userId },
    data: { actorId: null },
  });

  // 3. Delete user record (cascading deletes quizResults, chatMessages, dailyCheckins, talkNotes, talkReplies, talkReactions, talkReports, notifications)
  return await prisma.user.delete({
    where: { id: userId },
  });
}

/**
 * POST /api/auth/delete-account/send-otp
 *
 * Public Google Play Store compliant data deletion request endpoint.
 * Dispatches a 6-digit verification code to confirm user identity.
 */
router.post('/delete-account/send-otp', async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email?: string };
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email address is required' });
      return;
    }

    const emailLower = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({
      where: { email: emailLower },
    });

    if (!user) {
      // Safe generic message to avoid email enumeration
      res.status(200).json({
        success: true,
        message: 'If an active account is linked to this email, a verification code has been sent.',
      });
      return;
    }

    const code = generateOtpCode();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins

    deleteOtpStore.set(emailLower, { code, expiresAt });

    const delivered = await sendEmail({
      to: emailLower,
      sensitive: true,
      subject: 'Confirm Account & Data Deletion - WellMindly',
      html: getOtpTemplate(code, 'delete_account'),
    });
    if (!delivered) {
      res.status(503).json({ error: 'We could not send a verification code right now. Please try again in a few minutes.' });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Verification code sent to your registered email address.',
    });
  } catch (err: any) {
    console.error('Delete account OTP error:', err);
    res.status(500).json({ error: 'Failed to process deletion request. Please try again.' });
  }
});

/**
 * POST /api/auth/delete-account/confirm
 *
 * Verifies OTP and permanently deletes user and all associated data.
 */
router.post('/delete-account/confirm', async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body as { email?: string; otp?: string };
    if (!email || !otp || typeof email !== 'string') {
      res.status(400).json({ error: 'Email and verification code are required' });
      return;
    }

    const emailLower = email.toLowerCase().trim();
    const otpResult = checkOtp(deleteOtpStore, emailLower, otp);
    if (otpResult !== 'OK') {
      res.status(400).json({
        error: otpResult === 'EXPIRED'
          ? 'Verification code has expired. Please request a new code.'
          : otpResult === 'MISMATCH' ? 'Invalid verification code' : OTP_ERRORS[otpResult],
      });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email: emailLower },
    });

    if (user) {
      await deleteUserAndAssociatedData(user.id);

      // Send deletion confirmation email
      try {
        await sendEmail({
          to: emailLower,
          bcc: 'wellmindly@gmail.com',
          subject: 'Your WellMindly Account & Data Have Been Deleted',
          html: getAccountDeletedTemplate(user.firstName),
        });
      } catch (mailErr) {
        console.error('Failed to send deletion confirmation email:', mailErr);
      }
    }

    deleteOtpStore.delete(emailLower);

    res.status(200).json({
      success: true,
      message: 'Your WellMindly account and all associated personal data have been permanently erased.',
    });
  } catch (err: any) {
    console.error('Confirm account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
  }
});

/**
 * DELETE /api/auth/account
 *
 * Authenticated in-app account & data deletion.
 */
router.delete('/account', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.sub;
    const email = req.user?.email;

    if (!userId && !email) {
      res.status(401).json({ error: 'Unauthorized: missing user identity' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(userId ? [{ id: userId }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
    });

    if (!user) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    await deleteUserAndAssociatedData(user.id);

    try {
      await sendEmail({
        to: user.email,
        bcc: 'wellmindly@gmail.com',
        subject: 'Your WellMindly Account & Data Have Been Deleted',
        html: getAccountDeletedTemplate(user.firstName),
      });
    } catch (mailErr) {
      console.error('Failed to send in-app deletion confirmation email:', mailErr);
    }

    res.status(200).json({
      success: true,
      message: 'Your account and all associated personal data have been permanently erased.',
    });
  } catch (err: any) {
    console.error('In-app account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
  }
});

export default router;

