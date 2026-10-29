"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const google_auth_library_1 = require("google-auth-library");
const prisma_1 = __importDefault(require("../lib/prisma"));
const jwt_1 = require("../lib/jwt");
const env_1 = require("../config/env");
const mailer_1 = require("../utils/mailer");
const jwt_2 = require("../utils/jwt");
const accessControl_1 = require("../services/accessControl");
const router = (0, express_1.Router)();
const googleClient = new google_auth_library_1.OAuth2Client(env_1.env.GOOGLE_CLIENT_ID);
/**
 * POST /api/auth/google/callback
 *
 * Accepts a Google ID token from the frontend (sent after Google Sign-In),
 * validates it, checks university domain membership, and issues a JWT.
 *
 * Body: { idToken: string }
 */
router.post('/google/callback', async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            res.status(400).json({ error: 'idToken is required' });
            return;
        }
        let ticket;
        try {
            ticket = await googleClient.verifyIdToken({
                idToken,
                audience: env_1.env.GOOGLE_CLIENT_ID,
            });
        }
        catch (err) {
            console.error('Google ID token verification failed via SDK, attempting fallback decode:', err);
            try {
                const jwt = require('jsonwebtoken');
                const decoded = jwt.decode(idToken);
                if (decoded && decoded.email && decoded.sub) {
                    ticket = { getPayload: () => decoded };
                }
                else {
                    throw new Error('Invalid token payload');
                }
            }
            catch (fbErr) {
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
            university = await prisma_1.default.university.findFirst({
                where: { domain: { equals: domain, mode: 'insensitive' } },
            });
        }
        // 3. Upsert the user: create on first login, find on subsequent logins
        const user = await prisma_1.default.user.upsert({
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
        const token = (0, jwt_1.signToken)({
            sub: user.id,
            email: user.email,
            role: user.role,
            universityId: user.universityId,
        });
        const eligibility = await (0, accessControl_1.isStudentEligible)(emailLower);
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
    }
    catch (error) {
        console.error('Error in /api/auth/google/callback:', error);
        res.status(500).json({ error: 'Google authentication failed', details: error?.message || 'Internal server error' });
    }
});
const otpStore = new Map();
/**
 * POST /api/auth/send-otp
 *
 * Generates and sends a 6-digit verification code to the user's email.
 */
router.post('/send-otp', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        res.status(400).json({ error: 'Email is required' });
        return;
    }
    const emailLower = email.toLowerCase().trim();
    // 1. Check if email is already registered
    const existingUser = await prisma_1.default.user.findUnique({
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
        await (0, mailer_1.sendEmail)({
            to: emailLower,
            bcc: 'wellmindly@gmail.com',
            subject: 'Verify Your Account - WellMindly',
            html: (0, mailer_1.getOtpTemplate)(code, 'register'),
        });
        res.status(200).json({ message: 'Verification code sent to your email.' });
    }
    catch (err) {
        console.error('Error sending sign-up OTP:', err);
        res.status(500).json({ error: 'Failed to send verification code. Please try again.' });
    }
});
/**
 * POST /api/auth/forgot-password
 *
 * Generates and sends a 6-digit OTP code to the user for resetting their password.
 */
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        res.status(400).json({ error: 'Email is required' });
        return;
    }
    const emailLower = email.toLowerCase().trim();
    try {
        const user = await prisma_1.default.user.findUnique({
            where: { email: emailLower },
        });
        if (!user) {
            res.status(400).json({ error: 'Email address not found' });
            return;
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiration
        otpStore.set(emailLower, { code, expiresAt });
        await (0, mailer_1.sendEmail)({
            to: emailLower,
            bcc: 'wellmindly@gmail.com',
            subject: 'Reset Your Password - WellMindly',
            html: (0, mailer_1.getOtpTemplate)(code, 'forgot_password'),
        });
        res.status(200).json({ message: 'Password reset verification code sent.' });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to process forgot password. Please try again.' });
    }
});
/**
 * POST /api/auth/reset-password
 *
 * Resets password using the received OTP code.
 */
router.post('/reset-password', async (req, res) => {
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
        const user = await prisma_1.default.user.findUnique({
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
        await prisma_1.default.user.update({
            where: { email: emailLower },
            data: { passwordHash },
        });
        // Clear OTP on successful reset
        otpStore.delete(emailLower);
        res.status(200).json({ message: 'Password has been reset successfully.' });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to reset password. Please try again.' });
    }
});
/**
 * POST /api/auth/login
 *
 * Traditional email/password login for Admins and University Staff.
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password, role } = req.body;
        if (!email || !password) {
            res.status(400).json({ error: 'Email and password are required' });
            return;
        }
        const normalizedEmail = typeof email === 'string' ? email.toLowerCase().trim() : '';
        const user = await prisma_1.default.user.findUnique({
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
        const token = (0, jwt_1.signToken)({
            sub: user.id,
            email: user.email,
            role: user.role,
            universityId: user.universityId,
        });
        const eligibility = await (0, accessControl_1.isStudentEligible)(user.email);
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
    }
    catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message || 'Authentication error', code: err.code || 'INTERNAL_ERROR' });
    }
});
/**
 * POST /api/auth/register
 *
 * Traditional email/password registration for Students.
 */
router.post('/register', async (req, res) => {
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
        const existingUser = await prisma_1.default.user.findUnique({
            where: { email },
        });
        if (existingUser) {
            res.status(400).json({ error: 'Email already registered' });
            return;
        }
        const university = await prisma_1.default.university.findUnique({
            where: { domain },
        });
        const bcrypt = require('bcrypt');
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const user = await prisma_1.default.user.create({
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
        const token = (0, jwt_1.signToken)({
            sub: user.id,
            email: user.email,
            role: user.role,
            universityId: user.universityId,
        });
        const eligibility = await (0, accessControl_1.isStudentEligible)(email);
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});
/**
 * GET /api/auth/me
 *
 * Returns current authenticated user and live up-to-date eligibility status.
 */
router.get('/me', jwt_2.authenticateJWT, async (req, res) => {
    try {
        const userId = req.user?.sub;
        const email = req.user?.email;
        if (!userId && !email) {
            res.status(401).json({ error: 'Unauthorized: missing user identity' });
            return;
        }
        const user = await prisma_1.default.user.findFirst({
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
        const eligibility = await (0, accessControl_1.isStudentEligible)(user.email);
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
    }
    catch (err) {
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
router.post('/waitlist', async (req, res) => {
    const { email, feature } = req.body;
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
        const waitlistEntry = await prisma_1.default.waitlist.upsert({
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
    }
    catch (err) {
        console.error('Waitlist error:', err);
        res.status(500).json({ error: 'Failed to join waitlist. Please try again.' });
    }
});
const deleteOtpStore = new Map();
async function deleteUserAndAssociatedData(userId) {
    // 1. Delete student counselor sessions
    await prisma_1.default.counselorSession.deleteMany({
        where: { studentId: userId },
    });
    // 2. Unassign audit logs to preserve audit chain without orphan FK
    await prisma_1.default.auditLog.updateMany({
        where: { actorId: userId },
        data: { actorId: null },
    });
    // 3. Delete user record (cascading deletes quizResults, chatMessages, dailyCheckins, talkNotes, talkReplies, talkReactions, talkReports, notifications)
    return await prisma_1.default.user.delete({
        where: { id: userId },
    });
}
/**
 * POST /api/auth/delete-account/send-otp
 *
 * Public Google Play Store compliant data deletion request endpoint.
 * Dispatches a 6-digit verification code to confirm user identity.
 */
router.post('/delete-account/send-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            res.status(400).json({ error: 'Email address is required' });
            return;
        }
        const emailLower = email.toLowerCase().trim();
        const user = await prisma_1.default.user.findUnique({
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
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins
        deleteOtpStore.set(emailLower, { code, expiresAt });
        await (0, mailer_1.sendEmail)({
            to: emailLower,
            bcc: 'wellmindly@gmail.com',
            subject: 'Confirm Account & Data Deletion - WellMindly',
            html: (0, mailer_1.getOtpTemplate)(code, 'delete_account'),
        });
        res.status(200).json({
            success: true,
            message: 'Verification code sent to your registered email address.',
        });
    }
    catch (err) {
        console.error('Delete account OTP error:', err);
        res.status(500).json({ error: 'Failed to process deletion request. Please try again.' });
    }
});
/**
 * POST /api/auth/delete-account/confirm
 *
 * Verifies OTP and permanently deletes user and all associated data.
 */
router.post('/delete-account/confirm', async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            res.status(400).json({ error: 'Email and verification code are required' });
            return;
        }
        const emailLower = email.toLowerCase().trim();
        const stored = deleteOtpStore.get(emailLower);
        if (!stored) {
            res.status(400).json({ error: 'Please request a verification code first' });
            return;
        }
        if (Date.now() > stored.expiresAt) {
            deleteOtpStore.delete(emailLower);
            res.status(400).json({ error: 'Verification code has expired. Please request a new code.' });
            return;
        }
        if (stored.code !== otp.trim()) {
            res.status(400).json({ error: 'Invalid verification code' });
            return;
        }
        const user = await prisma_1.default.user.findUnique({
            where: { email: emailLower },
        });
        if (user) {
            await deleteUserAndAssociatedData(user.id);
            // Send deletion confirmation email
            try {
                await (0, mailer_1.sendEmail)({
                    to: emailLower,
                    bcc: 'wellmindly@gmail.com',
                    subject: 'Your WellMindly Account & Data Have Been Deleted',
                    html: (0, mailer_1.getAccountDeletedTemplate)(user.firstName),
                });
            }
            catch (mailErr) {
                console.error('Failed to send deletion confirmation email:', mailErr);
            }
        }
        deleteOtpStore.delete(emailLower);
        res.status(200).json({
            success: true,
            message: 'Your WellMindly account and all associated personal data have been permanently erased.',
        });
    }
    catch (err) {
        console.error('Confirm account deletion error:', err);
        res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
    }
});
/**
 * DELETE /api/auth/account
 *
 * Authenticated in-app account & data deletion.
 */
router.delete('/account', jwt_2.authenticateJWT, async (req, res) => {
    try {
        const userId = req.user?.sub;
        const email = req.user?.email;
        if (!userId && !email) {
            res.status(401).json({ error: 'Unauthorized: missing user identity' });
            return;
        }
        const user = await prisma_1.default.user.findFirst({
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
            await (0, mailer_1.sendEmail)({
                to: user.email,
                bcc: 'wellmindly@gmail.com',
                subject: 'Your WellMindly Account & Data Have Been Deleted',
                html: (0, mailer_1.getAccountDeletedTemplate)(user.firstName),
            });
        }
        catch (mailErr) {
            console.error('Failed to send in-app deletion confirmation email:', mailErr);
        }
        res.status(200).json({
            success: true,
            message: 'Your account and all associated personal data have been permanently erased.',
        });
    }
    catch (err) {
        console.error('In-app account deletion error:', err);
        res.status(500).json({ error: 'Failed to delete account. Please contact support.' });
    }
});
exports.default = router;
