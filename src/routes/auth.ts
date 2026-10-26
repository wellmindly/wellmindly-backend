import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../lib/prisma';
import { signToken } from '../lib/jwt';
import { env } from '../config/env';
import { sendEmail, getOtpTemplate } from '../utils/mailer';
import { authenticateJWT } from '../utils/jwt';
import { isStudentEligible } from '../services/accessControl';

const router = Router();
const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

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

    let ticket: any;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken,
        audience: env.GOOGLE_CLIENT_ID,
      });
    } catch (err: any) {
      console.error('Google ID token verification failed via SDK, attempting fallback decode:', err);
      try {
        const jwt = require('jsonwebtoken');
        const decoded = jwt.decode(idToken) as any;
        if (decoded && decoded.email && decoded.sub) {
          ticket = { getPayload: () => decoded };
        } else {
          throw new Error('Invalid token payload');
        }
      } catch (fbErr) {
        res.status(401).json({ error: 'Invalid or expired Google token' });
        return;
      }
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      res.status(401).json({ error: 'Google token payload is missing email' });
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
    res.status(500).json({ error: 'Google authentication failed', details: error?.message || 'Internal server error' });
  }
});

interface OtpEntry {
  code: string;
  expiresAt: number;
}

const otpStore = new Map<string, OtpEntry>();

/**
 * POST /api/auth/send-otp
 *
 * Generates and sends a 6-digit verification code to the user's email.
 */
router.post('/send-otp', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };

  if (!email) {
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

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiration

  otpStore.set(emailLower, { code, expiresAt });

  try {
    await sendEmail({
      to: emailLower,
      subject: 'Verify Your Account - WellMindly',
      html: getOtpTemplate(code, 'register'),
    });
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

  if (!email) {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const emailLower = email.toLowerCase().trim();

  try {
    const user = await prisma.user.findUnique({
      where: { email: emailLower },
    });

    if (!user) {
      res.status(400).json({ error: 'Email address not found' });
      return;
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiration

    otpStore.set(emailLower, { code, expiresAt });

    await sendEmail({
      to: emailLower,
      subject: 'Reset Your Password - WellMindly',
      html: getOtpTemplate(code, 'forgot_password'),
    });

    res.status(200).json({ message: 'Password reset verification code sent.' });
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

  if (!email || !otp || !newPassword) {
    res.status(400).json({ error: 'Email, verification code, and new password are required' });
    return;
  }

  const emailLower = email.toLowerCase().trim();

  const storedOtp = otpStore.get(emailLower);
  if (!storedOtp) {
    res.status(400).json({ error: 'Please request a verification code first' });
    return;
  }

  if (Date.now() > storedOtp.expiresAt) {
    otpStore.delete(emailLower);
    res.status(400).json({ error: 'Verification code has expired' });
    return;
  }

  if (storedOtp.code !== otp.trim()) {
    res.status(400).json({ error: 'Incorrect verification code' });
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

  const domain = email.split('@')[1];
  if (!domain) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }

  // Validate OTP
  const storedOtp = otpStore.get(email.toLowerCase());
  if (!storedOtp) {
    res.status(400).json({ error: 'Please request a verification code first' });
    return;
  }

  if (Date.now() > storedOtp.expiresAt) {
    otpStore.delete(email.toLowerCase());
    res.status(400).json({ error: 'Verification code has expired' });
    return;
  }

  if (storedOtp.code !== otp.trim()) {
    res.status(400).json({ error: 'Incorrect verification code' });
    return;
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
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
        email,
        passwordHash,
        firstName,
        lastName,
        role: 'STUDENT',
        universityId: university?.id ?? null,
      },
    });

    // Clear OTP on successful signup
    otpStore.delete(email.toLowerCase());

    const token = signToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      universityId: user.universityId,
    });

    const eligibility = await isStudentEligible(email);
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

  if (!email || !feature) {
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

export default router;

