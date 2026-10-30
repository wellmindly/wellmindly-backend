"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = __importDefault(require("crypto"));
const zod_1 = require("zod");
const prisma_1 = __importDefault(require("../lib/prisma"));
const jwt_1 = require("../utils/jwt");
const mailer_1 = require("../utils/mailer");
const emailQueue_1 = require("../utils/emailQueue");
const escapeHtml_1 = require("../utils/escapeHtml");
const env_1 = require("../config/env");
const waitlistProtection_1 = require("../middleware/waitlistProtection");
const waitlistLogger_1 = require("../utils/waitlistLogger");
const subscriberClassifier_1 = require("../utils/subscriberClassifier");
const contactSchema_1 = require("../services/contactSchema");
const router = (0, express_1.Router)();
const generalContactSchema = zod_1.z.object({
    name: zod_1.z.string().min(1, 'Name is required').trim(),
    email: zod_1.z
        .string()
        .min(1, 'Email is required')
        .transform((val) => (0, waitlistProtection_1.normalizeEmail)(val))
        .refine(waitlistProtection_1.isValidEmailSyntax, { message: 'Invalid email address' }),
    subject: zod_1.z.string().optional(),
    message: zod_1.z.string().min(1, 'Message is required'),
    captchaToken: zod_1.z.string().optional(),
    hp_confirm: zod_1.z.string().optional(),
    _t: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
});
const universityContactSchema = zod_1.z.object({
    name: zod_1.z.string().min(1, 'Name is required'),
    email: zod_1.z.string().email('Invalid email address'),
    universityName: zod_1.z.string().min(1, 'University name is required'),
    role: zod_1.z.string().min(1, 'Role is required'),
    phone: zod_1.z.string().optional(),
    message: zod_1.z.string().min(1, 'Message is required'),
});
const counselorContactSchema = zod_1.z.object({
    name: zod_1.z.string().min(1, 'Name is required'),
    email: zod_1.z.string().email('Invalid email address'),
    phone: zod_1.z.string().optional(),
    credentials: zod_1.z.string().min(1, 'Credentials are required'),
    experience: zod_1.z.string().min(1, 'Experience detail is required'),
    message: zod_1.z.string().min(1, 'Message is required'),
});
// --- Public Endpoints ---
router.post('/general', waitlistProtection_1.waitlistProtectionMiddleware, async (req, res) => {
    const requestId = req.requestId || (0, waitlistLogger_1.generateRequestId)();
    const clientIp = (0, waitlistProtection_1.getClientIp)(req);
    try {
        await (0, contactSchema_1.ensureContactRequestSchema)();
        const data = generalContactSchema.parse(req.body);
        const normEmail = (0, waitlistProtection_1.normalizeEmail)(data.email);
        const isNewsletter = data.name === 'Newsletter Subscriber' ||
            data.name === 'Newsletter Waitlist' ||
            (data.subject && /waitlist|newsletter/i.test(data.subject)) ||
            false;
        if (isNewsletter) {
            const campaign = (data.subject || 'Waitlist: Human Counselling for All Students').trim();
            const campaignKey = campaign.toLowerCase();
            const subscriptionKey = `${normEmail}::${campaignKey}`;
            (0, waitlistLogger_1.logWaitlistEvent)('SUBSCRIPTION_ATTEMPT', {
                requestId,
                ip: clientIp,
                email: normEmail,
                campaign,
            });
            // Check for existing subscription for this email & campaign
            const existing = await prisma_1.default.contactRequest.findFirst({
                where: { subscriptionKey },
            });
            if (existing) {
                (0, waitlistLogger_1.logWaitlistEvent)('DUPLICATE_PREVENTED', {
                    requestId,
                    ip: clientIp,
                    email: normEmail,
                    campaign,
                    reason: `Existing record with status=${existing.status}`,
                });
                if (existing.status === 'VERIFIED') {
                    // Idempotent generic safe response for confirmed subscriber
                    res.status(200).json({
                        success: true,
                        message: 'Thank you for your interest! If you are not already confirmed, please check your email for a verification link.',
                    });
                    return;
                }
                // If PENDING and token generated > 2 minutes ago, resend confirmation email
                const tokenAgeMs = existing.verificationExpiresAt
                    ? 24 * 60 * 60 * 1000 - (new Date(existing.verificationExpiresAt).getTime() - Date.now())
                    : Infinity;
                if (tokenAgeMs > 2 * 60 * 1000) {
                    const rawToken = crypto_1.default.randomBytes(32).toString('hex');
                    const tokenHash = crypto_1.default.createHash('sha256').update(rawToken).digest('hex');
                    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
                    await prisma_1.default.contactRequest.update({
                        where: { id: existing.id },
                        data: {
                            verificationTokenHash: tokenHash,
                            verificationExpiresAt: expiresAt,
                        },
                    });
                    const verifyUrl = `${env_1.env.STUDENT_PORTAL_URL}/verify-subscription?token=${rawToken}`;
                    try {
                        await (0, mailer_1.sendEmail)({
                            to: normEmail,
                            subject: `Verify your subscription: ${campaign}`,
                            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
                  <h2 style="color: #4f46e5; margin-top: 0;">Confirm Your Waitlist Subscription</h2>
                  <p>Hello,</p>
                  <p>We received a request to subscribe this email address to <strong>${(0, escapeHtml_1.escapeHtml)(campaign)}</strong> on WellMindly.</p>
                  <p>Please click the button below to verify your email address and activate your notifications:</p>
                  <p style="margin: 28px 0;">
                    <a href="${verifyUrl}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Confirm Subscription</a>
                  </p>
                  <p style="color: #64748b; font-size: 13px;">Or copy and paste this link in your browser:<br/><a href="${verifyUrl}" style="color: #4f46e5;">${verifyUrl}</a></p>
                  <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This single-use confirmation link will expire in 24 hours. If you did not request this, you can safely ignore this email.</p>
                </div>
              `,
                        });
                        (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_EMAIL_SENT', { requestId, ip: clientIp, email: normEmail, campaign });
                    }
                    catch (mailErr) {
                        (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_EMAIL_FAILED', { requestId, ip: clientIp, email: normEmail, campaign, reason: mailErr.message });
                    }
                }
                else {
                    (0, waitlistLogger_1.logWaitlistEvent)('RESEND_VERIFICATION_IGNORED', { requestId, ip: clientIp, email: normEmail, campaign, reason: 'Throttled within 2m window' });
                }
                res.status(200).json({
                    success: true,
                    message: 'Thank you for your interest! If you are not already confirmed, please check your email for a verification link.',
                });
                return;
            }
            // New subscriber: create pending or verified record
            const rawToken = crypto_1.default.randomBytes(32).toString('hex');
            const tokenHash = crypto_1.default.createHash('sha256').update(rawToken).digest('hex');
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            const isDoubleOptIn = env_1.env.ENABLE_DOUBLE_OPT_IN;
            let newRecord;
            try {
                newRecord = await prisma_1.default.contactRequest.create({
                    data: {
                        name: data.name,
                        email: data.email.trim(),
                        normalizedEmail: normEmail,
                        subject: campaign,
                        message: data.message,
                        status: isDoubleOptIn ? 'PENDING' : 'VERIFIED',
                        verifiedAt: isDoubleOptIn ? null : new Date(),
                        subscriptionKey,
                        verificationTokenHash: isDoubleOptIn ? tokenHash : null,
                        verificationExpiresAt: isDoubleOptIn ? expiresAt : null,
                    },
                });
                (0, waitlistLogger_1.logWaitlistEvent)('SUBSCRIPTION_CREATED', { requestId, ip: clientIp, email: normEmail, campaign, status: isDoubleOptIn ? 'PENDING' : 'VERIFIED' });
            }
            catch (err) {
                // Database unique constraint violation (P2002) - concurrent request handled gracefully
                if (err?.code === 'P2002') {
                    (0, waitlistLogger_1.logWaitlistEvent)('DUPLICATE_PREVENTED', {
                        requestId,
                        ip: clientIp,
                        email: normEmail,
                        campaign,
                        reason: 'Concurrent P2002 unique constraint caught',
                    });
                    res.status(200).json({
                        success: true,
                        message: 'Thank you for your interest! If you are not already confirmed, please check your email for a verification link.',
                    });
                    return;
                }
                throw err;
            }
            if (isDoubleOptIn) {
                const verifyUrl = `${env_1.env.STUDENT_PORTAL_URL}/verify-subscription?token=${rawToken}`;
                try {
                    await (0, mailer_1.sendEmail)({
                        to: normEmail,
                        subject: `Verify your subscription: ${campaign}`,
                        html: `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
                <h2 style="color: #4f46e5; margin-top: 0;">Confirm Your Waitlist Subscription</h2>
                <p>Hello,</p>
                <p>Thank you for requesting updates for <strong>${(0, escapeHtml_1.escapeHtml)(campaign)}</strong> on WellMindly.</p>
                <p>Please click the button below to verify your email address and activate your notifications:</p>
                <p style="margin: 28px 0;">
                  <a href="${verifyUrl}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Confirm Subscription</a>
                </p>
                <p style="color: #64748b; font-size: 13px;">Or copy and paste this link in your browser:<br/><a href="${verifyUrl}" style="color: #4f46e5;">${verifyUrl}</a></p>
                <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This single-use confirmation link will expire in 24 hours. If you did not request this, you can safely ignore this email.</p>
              </div>
            `,
                    });
                    (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_EMAIL_SENT', { requestId, ip: clientIp, email: normEmail, campaign });
                }
                catch (mailErr) {
                    (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_EMAIL_FAILED', { requestId, ip: clientIp, email: normEmail, campaign, reason: mailErr.message });
                }
            }
            res.status(201).json({
                success: true,
                message: isDoubleOptIn
                    ? 'Thank you for joining our waitlist! Please check your email to confirm your subscription.'
                    : 'Thank you for joining our waitlist!',
                status: isDoubleOptIn ? 'PENDING' : 'VERIFIED',
                data: {
                    id: newRecord.id,
                    email: newRecord.email,
                    subject: newRecord.subject,
                    status: newRecord.status,
                },
            });
            return;
        }
        // Standard Non-Newsletter Contact Inquiry
        const request = await prisma_1.default.contactRequest.create({
            data: {
                name: data.name,
                email: data.email.trim(),
                normalizedEmail: normEmail,
                subject: data.subject,
                message: data.message,
                status: 'VERIFIED',
                subscriptionKey: null,
            },
        });
        // (a) Submitter acknowledgement
        (0, emailQueue_1.queueEmail)({
            to: data.email,
            subject: `We've received your message: ${data.subject || 'General Inquiry'}`,
            html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">Message Received</h2>
          <p>Hello <strong>${(0, escapeHtml_1.escapeHtml)(data.name)}</strong>,</p>
          <p>Thank you for reaching out to WellMindly. We have received your message regarding <strong>${(0, escapeHtml_1.escapeHtml)(data.subject || 'General Inquiry')}</strong> and a member of our team will review it.</p>
          <p style="color: #64748b; font-size: 14px; margin-top: 20px;">WellMindly Student Support Team</p>
        </div>
      `,
        });
        // (b) Internal notification
        (0, emailQueue_1.queueEmail)({
            to: env_1.env.CONTACT_NOTIFY_TO,
            subject: `[Contact Request] ${data.subject || 'General Inquiry'} from ${data.name}`,
            html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">New Contact Request</h2>
          <p><strong>From:</strong> ${(0, escapeHtml_1.escapeHtml)(data.name)} (${(0, escapeHtml_1.escapeHtml)(data.email)})</p>
          <p><strong>Subject:</strong> ${(0, escapeHtml_1.escapeHtml)(data.subject || 'N/A')}</p>
          <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 16px 0;">
            <p style="white-space: pre-wrap; margin: 0;">${(0, escapeHtml_1.escapeHtml)(data.message)}</p>
          </div>
        </div>
      `,
        });
        res.status(201).json({ success: true, message: 'Message received', data: request });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            res.status(400).json({ success: false, error: error.issues[0].message });
            return;
        }
        console.error('Error creating general contact:', error);
        res.status(500).json({ success: false, error: 'Failed to submit contact request' });
    }
});
/**
 * GET /api/contacts/verify & POST /api/contacts/verify
 * Confirm double opt-in email verification via single-use expiring token.
 */
async function handleVerifySubscription(req, res) {
    const token = req.query.token || req.body?.token;
    const requestId = (0, waitlistLogger_1.generateRequestId)();
    const clientIp = (0, waitlistProtection_1.getClientIp)(req);
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
        (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_FAILED_INVALID', { requestId, ip: clientIp, reason: 'Empty token' });
        res.status(400).json({ success: false, error: 'Invalid verification token.' });
        return;
    }
    const tokenHash = crypto_1.default.createHash('sha256').update(token.trim()).digest('hex');
    try {
        const subscriber = await prisma_1.default.contactRequest.findFirst({
            where: { verificationTokenHash: tokenHash },
        });
        if (!subscriber) {
            (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_FAILED_INVALID', { requestId, ip: clientIp, reason: 'Token hash not found' });
            res.status(400).json({ success: false, error: 'Invalid or expired verification token.' });
            return;
        }
        if (subscriber.verificationExpiresAt && new Date(subscriber.verificationExpiresAt) < new Date()) {
            (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_FAILED_EXPIRED', {
                requestId,
                ip: clientIp,
                email: subscriber.normalizedEmail || undefined,
                reason: 'Token expired',
            });
            res.status(400).json({
                success: false,
                error: 'Verification token has expired. Please request a new verification link.',
            });
            return;
        }
        // Safe idempotent confirmation
        if (subscriber.status === 'VERIFIED') {
            (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_ALREADY_CONFIRMED', {
                requestId,
                ip: clientIp,
                email: subscriber.normalizedEmail || undefined,
            });
            res.status(200).json({
                success: true,
                message: 'Your subscription is already confirmed!',
            });
            return;
        }
        // Invalidate token on single use and mark as VERIFIED
        await prisma_1.default.contactRequest.update({
            where: { id: subscriber.id },
            data: {
                status: 'VERIFIED',
                verifiedAt: new Date(),
                verificationTokenHash: null,
            },
        });
        (0, waitlistLogger_1.logWaitlistEvent)('VERIFICATION_SUCCESS', {
            requestId,
            ip: clientIp,
            email: subscriber.normalizedEmail || undefined,
            campaign: subscriber.subject || undefined,
        });
        // If request accepts HTML (direct email click in browser), redirect to frontend confirmation page
        if (req.method === 'GET' && req.accepts('html') && !req.accepts('json')) {
            res.redirect(`${env_1.env.STUDENT_PORTAL_URL}/verify-subscription?status=confirmed`);
            return;
        }
        res.status(200).json({
            success: true,
            message: 'Your subscription has been confirmed successfully! Thank you for subscribing.',
        });
    }
    catch (error) {
        console.error('Error verifying subscription token:', error);
        res.status(500).json({ success: false, error: 'Verification failed. Please try again.' });
    }
}
router.get('/verify', handleVerifySubscription);
router.post('/verify', handleVerifySubscription);
/**
 * POST /api/contacts/resend-verification
 * Resend verification link to a pending subscriber.
 */
router.post('/resend-verification', waitlistProtection_1.waitlistProtectionMiddleware, async (req, res) => {
    const requestId = req.requestId || (0, waitlistLogger_1.generateRequestId)();
    const clientIp = (0, waitlistProtection_1.getClientIp)(req);
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
    const normEmail = (0, waitlistProtection_1.normalizeEmail)(rawEmail);
    const campaign = (req.body?.subject || req.body?.campaign || 'Waitlist: Human Counselling for All Students').trim();
    const subscriptionKey = `${normEmail}::${campaign.toLowerCase()}`;
    // Always return safe, generic 200 response to avoid disclosing subscriber presence
    const genericResponse = {
        success: true,
        message: 'If a pending subscription exists for that email address, a confirmation email has been sent.',
    };
    if (!(0, waitlistProtection_1.isValidEmailSyntax)(normEmail)) {
        res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
        return;
    }
    try {
        const subscriber = await prisma_1.default.contactRequest.findFirst({
            where: { subscriptionKey },
        });
        if (!subscriber || subscriber.status !== 'PENDING') {
            (0, waitlistLogger_1.logWaitlistEvent)('RESEND_VERIFICATION_IGNORED', {
                requestId,
                ip: clientIp,
                email: normEmail,
                campaign,
                reason: !subscriber ? 'No subscriber found' : 'Already confirmed',
            });
            res.status(200).json(genericResponse);
            return;
        }
        const rawToken = crypto_1.default.randomBytes(32).toString('hex');
        const tokenHash = crypto_1.default.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await prisma_1.default.contactRequest.update({
            where: { id: subscriber.id },
            data: {
                verificationTokenHash: tokenHash,
                verificationExpiresAt: expiresAt,
            },
        });
        const verifyUrl = `${env_1.env.STUDENT_PORTAL_URL}/verify-subscription?token=${rawToken}`;
        await (0, mailer_1.sendEmail)({
            to: normEmail,
            subject: `Verify your subscription: ${campaign}`,
            html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
          <h2 style="color: #4f46e5; margin-top: 0;">Confirm Your Waitlist Subscription</h2>
          <p>Hello,</p>
          <p>We received a request to resend the verification link for <strong>${(0, escapeHtml_1.escapeHtml)(campaign)}</strong> on WellMindly.</p>
          <p style="margin: 28px 0;">
            <a href="${verifyUrl}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Confirm Subscription</a>
          </p>
          <p style="color: #64748b; font-size: 13px;">Or copy and paste this link in your browser:<br/><a href="${verifyUrl}" style="color: #4f46e5;">${verifyUrl}</a></p>
          <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This link will expire in 24 hours.</p>
        </div>
      `,
        });
        (0, waitlistLogger_1.logWaitlistEvent)('RESEND_VERIFICATION_SENT', { requestId, ip: clientIp, email: normEmail, campaign });
        res.status(200).json(genericResponse);
    }
    catch (error) {
        console.error('Error resending verification email:', error);
        res.status(200).json(genericResponse);
    }
});
/**
 * GET /api/contacts/waitlist/metrics
 * Operational telemetry for waitlist & newsletter subscriptions (ADMIN only)
 */
router.get('/waitlist/metrics', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        await (0, contactSchema_1.ensureContactRequestSchema)();
        const memorySnapshot = waitlistLogger_1.waitlistMetrics.getSnapshot();
        const [totalCount, verifiedCount, pendingCount] = await Promise.all([
            prisma_1.default.contactRequest.count({
                where: {
                    OR: [
                        { name: { in: ['Newsletter Subscriber', 'Newsletter Waitlist'] } },
                        { subject: { contains: 'waitlist', mode: 'insensitive' } },
                        { subject: { contains: 'newsletter', mode: 'insensitive' } },
                    ],
                },
            }),
            prisma_1.default.contactRequest.count({
                where: {
                    status: 'VERIFIED',
                    OR: [
                        { name: { in: ['Newsletter Subscriber', 'Newsletter Waitlist'] } },
                        { subject: { contains: 'waitlist', mode: 'insensitive' } },
                        { subject: { contains: 'newsletter', mode: 'insensitive' } },
                    ],
                },
            }),
            prisma_1.default.contactRequest.count({
                where: {
                    status: 'PENDING',
                    OR: [
                        { name: { in: ['Newsletter Subscriber', 'Newsletter Waitlist'] } },
                        { subject: { contains: 'waitlist', mode: 'insensitive' } },
                        { subject: { contains: 'newsletter', mode: 'insensitive' } },
                    ],
                },
            }),
        ]);
        res.status(200).json({
            success: true,
            metrics: {
                ...memorySnapshot,
                databaseTotalWaitlist: totalCount,
                databaseConfirmedVerified: verifiedCount,
                databasePendingVerification: pendingCount,
            },
        });
    }
    catch (error) {
        console.error('Error fetching waitlist metrics:', error);
        res.status(500).json({ error: 'Failed to fetch waitlist metrics' });
    }
});
router.post('/university', async (req, res) => {
    try {
        const data = universityContactSchema.parse(req.body);
        const request = await prisma_1.default.universityOnboarding.create({ data });
        // (a) Submitter acknowledgement
        (0, emailQueue_1.queueEmail)({
            to: data.email,
            subject: `University Partnership Inquiry: ${data.universityName}`,
            html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">University Onboarding Request Received</h2>
          <p>Hello <strong>${(0, escapeHtml_1.escapeHtml)(data.name)}</strong>,</p>
          <p>Thank you for your interest in bringing WellMindly to <strong>${(0, escapeHtml_1.escapeHtml)(data.universityName)}</strong>. Our partnerships team has received your request and will review your institution's details.</p>
          <p style="color: #64748b; font-size: 14px; margin-top: 20px;">WellMindly University Partnerships</p>
        </div>
      `,
        });
        // (b) Internal notification
        (0, emailQueue_1.queueEmail)({
            to: env_1.env.CONTACT_NOTIFY_TO,
            subject: `[University Partnership] ${data.universityName} from ${data.name}`,
            html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">New University Onboarding Request</h2>
          <p><strong>Contact:</strong> ${(0, escapeHtml_1.escapeHtml)(data.name)} (${(0, escapeHtml_1.escapeHtml)(data.email)})</p>
          <p><strong>University:</strong> ${(0, escapeHtml_1.escapeHtml)(data.universityName)}</p>
          <p><strong>Role:</strong> ${(0, escapeHtml_1.escapeHtml)(data.role)}</p>
          <p><strong>Phone:</strong> ${(0, escapeHtml_1.escapeHtml)(data.phone || 'N/A')}</p>
          <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 16px 0;">
            <p style="white-space: pre-wrap; margin: 0;">${(0, escapeHtml_1.escapeHtml)(data.message)}</p>
          </div>
        </div>
      `,
        });
        res.status(201).json({ success: true, message: 'University onboarding request received', data: request });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: error.issues[0].message });
            return;
        }
        console.error('Error creating university contact:', error);
        res.status(500).json({ error: 'Failed to submit university onboarding request' });
    }
});
router.post('/counselor', async (req, res) => {
    try {
        const data = counselorContactSchema.parse(req.body);
        const request = await prisma_1.default.counselorOnboarding.create({ data });
        // (a) Submitter acknowledgement
        (0, emailQueue_1.queueEmail)({
            to: data.email,
            subject: `Counselor Application Received: ${data.name}`,
            html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">Counselor Application Received</h2>
          <p>Hello <strong>${(0, escapeHtml_1.escapeHtml)(data.name)}</strong>,</p>
          <p>Thank you for applying to join the WellMindly counselor network. We have received your application with credentials (<strong>${(0, escapeHtml_1.escapeHtml)(data.credentials)}</strong>) and our counselor review team will assess your submission.</p>
          <p style="color: #64748b; font-size: 14px; margin-top: 20px;">WellMindly Counselor Operations</p>
        </div>
      `,
        });
        // (b) Internal notification
        (0, emailQueue_1.queueEmail)({
            to: env_1.env.CONTACT_NOTIFY_TO,
            subject: `[Counselor Application] ${data.name} (${data.credentials})`,
            html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">New Counselor Application</h2>
          <p><strong>Applicant:</strong> ${(0, escapeHtml_1.escapeHtml)(data.name)} (${(0, escapeHtml_1.escapeHtml)(data.email)})</p>
          <p><strong>Phone:</strong> ${(0, escapeHtml_1.escapeHtml)(data.phone || 'N/A')}</p>
          <p><strong>Credentials:</strong> ${(0, escapeHtml_1.escapeHtml)(data.credentials)}</p>
          <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 16px 0;">
            <p><strong>Experience:</strong></p>
            <p style="white-space: pre-wrap; margin: 0 0 12px 0;">${(0, escapeHtml_1.escapeHtml)(data.experience)}</p>
            <p><strong>Message / Statement:</strong></p>
            <p style="white-space: pre-wrap; margin: 0;">${(0, escapeHtml_1.escapeHtml)(data.message)}</p>
          </div>
        </div>
      `,
        });
        res.status(201).json({ success: true, message: 'Counselor application submitted successfully', data: request });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            res.status(400).json({ error: error.issues[0].message });
            return;
        }
        console.error('Error creating counselor contact:', error);
        res.status(500).json({ error: 'Failed to submit counselor onboarding request' });
    }
});
router.get('/coaches', async (_req, res) => {
    try {
        const counselors = await prisma_1.default.counselorProfile.findMany({
            where: { status: 'ACTIVE', deletedAt: null },
            include: {
                user: {
                    select: { firstName: true, lastName: true, email: true },
                },
                receivedFeedback: {
                    select: { rating: true },
                },
            },
            orderBy: { createdAt: 'asc' },
        });
        const formatted = counselors.map((c) => {
            const name = `${c.user.firstName} ${c.user.lastName}`;
            const init = `${c.user.firstName?.[0] || ''}${c.user.lastName?.[0] || ''}`.toUpperCase() || 'WC';
            const ratings = c.receivedFeedback?.map((f) => f.rating) || [];
            const totalReviews = ratings.length;
            const averageRating = totalReviews > 0
                ? parseFloat((ratings.reduce((acc, r) => acc + r, 0) / totalReviews).toFixed(1))
                : 4.9;
            return {
                id: c.id,
                name,
                firstName: c.user.firstName,
                lastName: c.user.lastName,
                role: c.credentials ? `${c.credentials.split(',')[0]}` : 'Wellbeing Coach',
                credentials: c.credentials,
                specializations: c.specializations,
                specs: c.specializations.slice(0, 3),
                bio: c.bio,
                avatarUrl: c.avatarUrl,
                init,
                rating: averageRating,
                totalReviews,
            };
        });
        res.status(200).json({ success: true, coaches: formatted });
    }
    catch (error) {
        console.error('Error fetching public coaches:', error);
        res.status(500).json({ error: 'Failed to fetch coaches' });
    }
});
// --- Admin Endpoints (Auth required + ADMIN role) ---
router.get('/general', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const type = (req.query.type || '').toLowerCase().trim();
        const skip = (page - 1) * limit;
        const statusFilter = (req.query.status || '').toUpperCase().trim();
        let whereClause = undefined;
        if (type === 'newsletter') {
            whereClause = {
                OR: [
                    { name: { in: ['Newsletter Subscriber', 'Newsletter Waitlist'] } },
                    { subject: { contains: 'waitlist', mode: 'insensitive' } },
                    { subject: { contains: 'newsletter', mode: 'insensitive' } },
                ],
            };
        }
        else if (type === 'inquiries') {
            whereClause = {
                AND: [
                    { name: { notIn: ['Newsletter Subscriber', 'Newsletter Waitlist'] } },
                    {
                        OR: [
                            { subject: null },
                            {
                                AND: [
                                    { subject: { not: { contains: 'waitlist', mode: 'insensitive' } } },
                                    { subject: { not: { contains: 'newsletter', mode: 'insensitive' } } },
                                ],
                            },
                        ],
                    },
                ],
            };
        }
        if (statusFilter && (statusFilter === 'VERIFIED' || statusFilter === 'PENDING')) {
            if (whereClause) {
                whereClause = { AND: [whereClause, { status: statusFilter }] };
            }
            else {
                whereClause = { status: statusFilter };
            }
        }
        await (0, contactSchema_1.ensureContactRequestSchema)();
        let contacts = [];
        let total = 0;
        try {
            [contacts, total] = await Promise.all([
                prisma_1.default.contactRequest.findMany({
                    where: whereClause,
                    orderBy: { createdAt: 'desc' },
                    skip,
                    take: limit,
                }),
                prisma_1.default.contactRequest.count({ where: whereClause }),
            ]);
        }
        catch (prismaQueryError) {
            console.warn('Prisma findMany query failed in GET /contacts/general, using raw SQL query fallback:', prismaQueryError?.message);
            let sqlWhere = 'WHERE 1=1';
            if (type === 'newsletter') {
                sqlWhere += ` AND ("name" IN ('Newsletter Subscriber', 'Newsletter Waitlist') OR "subject" ILIKE '%waitlist%' OR "subject" ILIKE '%newsletter%')`;
            }
            else if (type === 'inquiries') {
                sqlWhere += ` AND ("name" NOT IN ('Newsletter Subscriber', 'Newsletter Waitlist') AND ("subject" IS NULL OR ("subject" NOT ILIKE '%waitlist%' AND "subject" NOT ILIKE '%newsletter%')))`;
            }
            const rawRows = await prisma_1.default.$queryRawUnsafe(`
          SELECT "id", "name", "email", "subject", "message", "createdAt"
          FROM "ContactRequest"
          ${sqlWhere}
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${skip}
        `);
            const countRes = await prisma_1.default.$queryRawUnsafe(`
          SELECT COUNT(*)::int as count FROM "ContactRequest" ${sqlWhere}
        `);
            contacts = rawRows.map((r) => ({
                ...r,
                status: 'VERIFIED',
            }));
            total = countRes[0]?.count || contacts.length;
        }
        res.status(200).json({ contacts, total, page, limit });
    }
    catch (error) {
        console.error('Error fetching general contacts:', error);
        res.status(500).json({ error: 'Failed to fetch general contacts' });
    }
});
router.get('/university', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const [requests, total] = await Promise.all([
            prisma_1.default.universityOnboarding.findMany({
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma_1.default.universityOnboarding.count(),
        ]);
        res.status(200).json({ requests, total, page, limit });
    }
    catch (error) {
        console.error('Error fetching university contacts:', error);
        res.status(500).json({ error: 'Failed to fetch university requests' });
    }
});
router.get('/counselor', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;
        const [requests, total] = await Promise.all([
            prisma_1.default.counselorOnboarding.findMany({
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma_1.default.counselorOnboarding.count(),
        ]);
        const emails = requests.map((r) => r.email.trim().toLowerCase());
        const appIds = requests.map((r) => r.id);
        const [invitations, users, auditLogs] = await Promise.all([
            prisma_1.default.counselorInvitation.findMany({
                where: { email: { in: emails } },
            }),
            prisma_1.default.user.findMany({
                where: { email: { in: emails }, role: 'COUNSELOR' },
                include: { counselorProfile: true },
            }),
            prisma_1.default.auditLog.findMany({
                where: {
                    targetEntity: 'CounselorOnboarding',
                    targetId: { in: appIds },
                },
                orderBy: { createdAt: 'desc' },
            }),
        ]);
        const invMap = new Map(invitations.map((i) => [i.email.toLowerCase(), i]));
        const userMap = new Map(users.map((u) => [u.email.toLowerCase(), u]));
        const auditMap = new Map();
        auditLogs.forEach((a) => {
            if (!a.targetId)
                return;
            if (!auditMap.has(a.targetId))
                auditMap.set(a.targetId, []);
            auditMap.get(a.targetId).push(a);
        });
        const enrichedRequests = requests.map((r) => {
            const cleanEmail = r.email.trim().toLowerCase();
            const user = userMap.get(cleanEmail);
            const inv = invMap.get(cleanEmail);
            const logs = auditMap.get(r.id) || [];
            const docsLog = logs.find((l) => l.action === 'COUNSELOR_DOCS_REQUESTED');
            const inviteLog = logs.find((l) => l.action === 'COUNSELOR_INVITE_SENT');
            let stage = 'NEW_APPLICATION';
            let stageLabel = 'New Application';
            let stageUpdatedAt = null;
            let details = null;
            const docsTime = docsLog ? new Date(docsLog.createdAt).getTime() : 0;
            const inviteTime = inviteLog ? new Date(inviteLog.createdAt).getTime() : (inv ? new Date(inv.createdAt).getTime() : 0);
            if (docsTime > 0 && docsTime >= inviteTime) {
                // Documents were requested for this applicant
                stage = 'DOCS_REQUESTED';
                stageLabel = 'Degree & ID Docs Requested';
                stageUpdatedAt = docsLog.createdAt.toISOString();
                details = docsLog.details;
            }
            else if (inv || inviteLog) {
                if (inv?.used || (user && user.counselorProfile?.status === 'ACTIVE')) {
                    stage = 'ONBOARDED';
                    stageLabel = 'Onboarded & Active';
                    stageUpdatedAt = user?.counselorProfile?.updatedAt ? user.counselorProfile.updatedAt.toISOString() : (inv?.createdAt ? inv.createdAt.toISOString() : null);
                }
                else {
                    stage = 'INVITE_SENT';
                    stageLabel = 'Invitation Link Dispatched';
                    stageUpdatedAt = inv?.createdAt ? inv.createdAt.toISOString() : (inviteLog?.createdAt ? inviteLog.createdAt.toISOString() : null);
                    details = { expiresAt: inv?.expiresAt };
                }
            }
            else if (docsLog) {
                stage = 'DOCS_REQUESTED';
                stageLabel = 'Degree & ID Docs Requested';
                stageUpdatedAt = docsLog.createdAt.toISOString();
                details = docsLog.details;
            }
            else if (user && user.counselorProfile?.status === 'ACTIVE') {
                stage = 'ONBOARDED';
                stageLabel = 'Onboarded & Active';
                stageUpdatedAt = user.counselorProfile.updatedAt.toISOString();
            }
            return {
                ...r,
                stage,
                stageLabel,
                stageUpdatedAt,
                details,
            };
        });
        res.status(200).json({ requests: enrichedRequests, total, page, limit });
    }
    catch (error) {
        console.error('Error fetching counselor contacts:', error);
        res.status(500).json({ error: 'Failed to fetch counselor applications' });
    }
});
router.delete('/general/:id', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const id = req.params.id;
        await prisma_1.default.contactRequest.delete({ where: { id } });
        res.status(200).json({ success: true, message: 'Contact request deleted' });
    }
    catch (error) {
        if (error?.code === 'P2025') {
            res.status(404).json({ error: 'Contact request not found' });
            return;
        }
        console.error('Error deleting contact request:', error);
        res.status(500).json({ error: 'Failed to delete contact request' });
    }
});
router.post('/general/batch-delete', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            res.status(400).json({ error: 'Array of ids is required' });
            return;
        }
        const result = await prisma_1.default.contactRequest.deleteMany({
            where: { id: { in: ids } },
        });
        res.status(200).json({ success: true, count: result.count });
    }
    catch (error) {
        console.error('Error batch deleting contacts:', error);
        res.status(500).json({ error: 'Failed to batch delete contacts' });
    }
});
router.post('/general/newsletter/archive-fake-bots', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        await (0, contactSchema_1.ensureContactRequestSchema)();
        let records = [];
        try {
            records = await prisma_1.default.contactRequest.findMany({
                where: {
                    OR: [
                        { name: { in: ['Newsletter Subscriber', 'Newsletter Waitlist'] } },
                        { subject: { contains: 'waitlist', mode: 'insensitive' } },
                        { subject: { contains: 'newsletter', mode: 'insensitive' } },
                    ],
                },
                orderBy: { createdAt: 'asc' },
            });
        }
        catch (e) {
            records = await prisma_1.default.$queryRawUnsafe(`
          SELECT * FROM "ContactRequest"
          WHERE "name" IN ('Newsletter Subscriber', 'Newsletter Waitlist')
             OR "subject" ILIKE '%waitlist%'
             OR "subject" ILIKE '%newsletter%'
          ORDER BY "createdAt" ASC
        `);
        }
        const counts = new Map();
        for (const r of records) {
            const norm = (r.normalizedEmail || r.email || '').trim().toLowerCase();
            counts.set(norm, (counts.get(norm) || 0) + 1);
        }
        const fakeIds = [];
        const fakeRecordsToArchive = [];
        const seenRealEmails = new Set();
        const realUpdates = [];
        for (const r of records) {
            const norm = (r.normalizedEmail || r.email || '').trim().toLowerCase();
            const classification = (0, subscriberClassifier_1.classifySubscriber)(r.email, counts.get(norm) || 1);
            if (classification.isFake) {
                fakeIds.push(r.id);
                fakeRecordsToArchive.push({
                    originalId: r.id,
                    name: r.name || 'Newsletter Subscriber',
                    email: r.email,
                    normalizedEmail: norm,
                    subject: r.subject || 'Waitlist: Human Counselling for All Students',
                    message: r.message || '',
                    classificationReasons: classification.reasons.join('; '),
                    botScore: classification.score,
                    originalCreatedAt: r.createdAt ? new Date(r.createdAt) : new Date(),
                });
            }
            else {
                // Real subscriber: keep first (earliest) submission, archive subsequent duplicate submissions
                if (seenRealEmails.has(norm)) {
                    fakeIds.push(r.id);
                    fakeRecordsToArchive.push({
                        originalId: r.id,
                        name: r.name || 'Newsletter Subscriber',
                        email: r.email,
                        normalizedEmail: norm,
                        subject: r.subject || 'Waitlist: Human Counselling for All Students',
                        message: r.message || '',
                        classificationReasons: 'Duplicate submission consolidated',
                        botScore: 0,
                        originalCreatedAt: r.createdAt ? new Date(r.createdAt) : new Date(),
                    });
                }
                else {
                    seenRealEmails.add(norm);
                    const campaign = (r.subject || 'Waitlist: Human Counselling for All Students').trim().toLowerCase();
                    const subKey = `${norm}::${campaign}`;
                    realUpdates.push({ id: r.id, subscriptionKey: subKey });
                }
            }
        }
        if (fakeRecordsToArchive.length > 0) {
            const chunkSize = 100;
            for (let i = 0; i < fakeRecordsToArchive.length; i += chunkSize) {
                const chunk = fakeRecordsToArchive.slice(i, i + chunkSize);
                await prisma_1.default.archivedFakeContactRequest.createMany({
                    data: chunk,
                });
            }
            for (let i = 0; i < fakeIds.length; i += chunkSize) {
                const chunk = fakeIds.slice(i, i + chunkSize);
                await prisma_1.default.contactRequest.deleteMany({
                    where: { id: { in: chunk } },
                });
            }
        }
        for (const u of realUpdates) {
            await prisma_1.default.contactRequest.update({
                where: { id: u.id },
                data: {
                    subscriptionKey: u.subscriptionKey,
                    status: 'VERIFIED',
                },
            });
        }
        try {
            await prisma_1.default.$executeRawUnsafe(`
          CREATE UNIQUE INDEX IF NOT EXISTS "ContactRequest_subscriptionKey_key" ON "ContactRequest"("subscriptionKey");
        `);
        }
        catch (idxErr) {
            console.warn('Could not create unique index on subscriptionKey:', idxErr);
        }
        const retainedRealCount = seenRealEmails.size;
        res.status(200).json({
            success: true,
            archivedCount: fakeIds.length,
            retainedRealCount,
            message: `Successfully quarantined ${fakeIds.length} bot submissions. Preserved ${retainedRealCount} real subscribers.`,
        });
    }
    catch (error) {
        console.error('Error archiving fake bot subscribers:', error);
        res.status(500).json({ error: 'Failed to archive fake bot subscribers' });
    }
});
router.delete('/general/newsletter/all', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        await (0, contactSchema_1.ensureContactRequestSchema)();
        let records = [];
        try {
            records = await prisma_1.default.contactRequest.findMany({
                where: {
                    OR: [
                        { name: { in: ['Newsletter Subscriber', 'Newsletter Waitlist'] } },
                        { subject: { contains: 'waitlist', mode: 'insensitive' } },
                        { subject: { contains: 'newsletter', mode: 'insensitive' } },
                    ],
                },
                orderBy: { createdAt: 'asc' },
            });
        }
        catch (e) {
            records = await prisma_1.default.$queryRawUnsafe(`
          SELECT * FROM "ContactRequest"
          WHERE "name" IN ('Newsletter Subscriber', 'Newsletter Waitlist')
             OR "subject" ILIKE '%waitlist%'
             OR "subject" ILIKE '%newsletter%'
          ORDER BY "createdAt" ASC
        `);
        }
        const counts = new Map();
        for (const r of records) {
            const norm = (r.normalizedEmail || r.email || '').trim().toLowerCase();
            counts.set(norm, (counts.get(norm) || 0) + 1);
        }
        const fakeIds = [];
        const fakeRecordsToArchive = [];
        const seenRealEmails = new Set();
        const realUpdates = [];
        for (const r of records) {
            const norm = (r.normalizedEmail || r.email || '').trim().toLowerCase();
            const classification = (0, subscriberClassifier_1.classifySubscriber)(r.email, counts.get(norm) || 1);
            if (classification.isFake) {
                fakeIds.push(r.id);
                fakeRecordsToArchive.push({
                    originalId: r.id,
                    name: r.name || 'Newsletter Subscriber',
                    email: r.email,
                    normalizedEmail: norm,
                    subject: r.subject || 'Waitlist: Human Counselling for All Students',
                    message: r.message || '',
                    classificationReasons: classification.reasons.join('; '),
                    botScore: classification.score,
                    originalCreatedAt: r.createdAt ? new Date(r.createdAt) : new Date(),
                });
            }
            else {
                if (seenRealEmails.has(norm)) {
                    fakeIds.push(r.id);
                    fakeRecordsToArchive.push({
                        originalId: r.id,
                        name: r.name || 'Newsletter Subscriber',
                        email: r.email,
                        normalizedEmail: norm,
                        subject: r.subject || 'Waitlist: Human Counselling for All Students',
                        message: r.message || '',
                        classificationReasons: 'Duplicate submission consolidated',
                        botScore: 0,
                        originalCreatedAt: r.createdAt ? new Date(r.createdAt) : new Date(),
                    });
                }
                else {
                    seenRealEmails.add(norm);
                    const campaign = (r.subject || 'Waitlist: Human Counselling for All Students').trim().toLowerCase();
                    const subKey = `${norm}::${campaign}`;
                    realUpdates.push({ id: r.id, subscriptionKey: subKey });
                }
            }
        }
        if (fakeRecordsToArchive.length > 0) {
            const chunkSize = 100;
            for (let i = 0; i < fakeRecordsToArchive.length; i += chunkSize) {
                const chunk = fakeRecordsToArchive.slice(i, i + chunkSize);
                await prisma_1.default.archivedFakeContactRequest.createMany({
                    data: chunk,
                });
            }
            for (let i = 0; i < fakeIds.length; i += chunkSize) {
                const chunk = fakeIds.slice(i, i + chunkSize);
                await prisma_1.default.contactRequest.deleteMany({
                    where: { id: { in: chunk } },
                });
            }
        }
        for (const u of realUpdates) {
            await prisma_1.default.contactRequest.update({
                where: { id: u.id },
                data: {
                    subscriptionKey: u.subscriptionKey,
                    status: 'VERIFIED',
                },
            });
        }
        try {
            await prisma_1.default.$executeRawUnsafe(`
          CREATE UNIQUE INDEX IF NOT EXISTS "ContactRequest_subscriptionKey_key" ON "ContactRequest"("subscriptionKey");
        `);
        }
        catch (idxErr) {
            console.warn('Could not create unique index on subscriptionKey:', idxErr);
        }
        const retainedRealCount = seenRealEmails.size;
        res.status(200).json({
            success: true,
            count: fakeIds.length,
            archivedCount: fakeIds.length,
            retainedRealCount,
            message: `Successfully quarantined ${fakeIds.length} bot submissions. Preserved ${retainedRealCount} real subscribers.`,
        });
    }
    catch (error) {
        console.error('Error purging newsletter subscribers:', error);
        res.status(500).json({ error: 'Failed to purge subscribers' });
    }
});
router.delete('/university/:id', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const id = req.params.id;
        await prisma_1.default.universityOnboarding.delete({ where: { id } });
        res.status(200).json({ success: true, message: 'University request deleted' });
    }
    catch (error) {
        if (error?.code === 'P2025') {
            res.status(404).json({ error: 'University request not found' });
            return;
        }
        console.error('Error deleting university request:', error);
        res.status(500).json({ error: 'Failed to delete university onboarding request' });
    }
});
router.delete('/counselor/:id', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const id = req.params.id;
        await prisma_1.default.counselorOnboarding.delete({ where: { id } });
        res.status(200).json({ success: true, message: 'Counselor request deleted' });
    }
    catch (error) {
        if (error?.code === 'P2025') {
            res.status(404).json({ error: 'Counselor request not found' });
            return;
        }
        console.error('Error deleting counselor request:', error);
        res.status(500).json({ error: 'Failed to delete counselor onboarding request' });
    }
});
router.post('/counselor/:id/request-docs', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const id = req.params.id;
        const application = await prisma_1.default.counselorOnboarding.findUnique({ where: { id } });
        if (!application) {
            res.status(404).json({ error: 'Counselor application not found' });
            return;
        }
        const emailSubject = 'Document & Certificate Verification Request - WellMindly Counselor Application';
        const emailHtml = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
          <h2 style="color: #4f46e5; margin-top: 0;">WellMindly Counselor Application Verification</h2>
          <p>Hello <strong>${application.name}</strong>,</p>
          <p>Thank you for submitting your counselor onboarding application to WellMindly. We are reviewing your application credentials (<em>${application.credentials}</em>).</p>
          <p>To proceed with your application review and onboard you to our counselor network, please reply to this email with the following documents attached:</p>
          <ul style="padding-left: 20px; color: #334155;">
            <li><strong>Degree & Professional Certificates</strong> (M.A., Ph.D., RBT, or professional certifications)</li>
            <li><strong>Government-issued Identity Document</strong> (Passport or ID)</li>
            <li><strong>Proof of Professional License / Practice Standing</strong></li>
            <li>Any additional background documentation or reference letters</li>
          </ul>
          <p>If you have any questions, feel free to reply directly to this message or contact our team at <a href="mailto:wellmindly@gmail.com" style="color: #4f46e5;">wellmindly@gmail.com</a>.</p>
          <p style="margin-top: 24px; color: #64748b; font-size: 13px;">Warm regards,<br /><strong>The WellMindly Counselor Operations Team</strong></p>
        </div>
      `;
        await (0, mailer_1.sendEmail)({
            to: application.email,
            subject: emailSubject,
            html: emailHtml,
        });
        // Record journey stage in audit log for tracking
        await prisma_1.default.auditLog.create({
            data: {
                action: 'COUNSELOR_DOCS_REQUESTED',
                targetEntity: 'CounselorOnboarding',
                targetId: id,
                actorId: req.user?.sub || null,
                details: {
                    requestedBy: req.user?.email || 'admin',
                    requestedDocs: ['Degree Certificate', 'Identity Document', 'Practice Standing License'],
                    timestamp: new Date().toISOString(),
                },
            },
        });
        res.status(200).json({
            success: true,
            message: `Document & certificate request email sent to ${application.email}`,
        });
    }
    catch (error) {
        console.error('Error requesting counselor documents:', error);
        res.status(500).json({ error: 'Failed to send document request email' });
    }
});
router.post('/counselor/:id/approve-onboard', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const id = req.params.id;
        const application = await prisma_1.default.counselorOnboarding.findUnique({ where: { id } });
        if (!application) {
            res.status(404).json({ error: 'Counselor application not found' });
            return;
        }
        const nameParts = application.name.trim().split(' ');
        const firstName = nameParts[0] || application.name;
        const lastName = nameParts.slice(1).join(' ') || 'Counselor';
        const cleanEmail = application.email.trim().toLowerCase();
        let user = await prisma_1.default.user.findUnique({ where: { email: cleanEmail } });
        if (!user) {
            const token = crypto_1.default.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
            const invitation = await prisma_1.default.counselorInvitation.upsert({
                where: { email: cleanEmail },
                update: { firstName, lastName, token, expiresAt, used: false },
                create: { email: cleanEmail, firstName, lastName, token, expiresAt },
            });
            const host = req.get('host') || '';
            const origin = req.get('origin') || '';
            const isLocalDev = (host.includes('localhost') || host.includes('127.0.0.1')) && !origin.includes('wellmindly.com');
            const counselorPortalBase = isLocalDev ? (env_1.env.COUNSELOR_PORTAL_URL || 'http://localhost:5174') : 'https://counselor.wellmindly.com';
            const setupUrl = `${counselorPortalBase}/setup-profile?token=${token}`;
            await (0, mailer_1.sendEmail)({
                to: cleanEmail,
                subject: 'Congratulations! Your WellMindly Counselor Application is Approved',
                html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
              <h2 style="color: #4f46e5; margin-top: 0;">Application Approved & Onboarding Invitation</h2>
              <p>Hello <strong>${firstName} ${lastName}</strong>,</p>
              <p>We are delighted to inform you that your counselor onboarding application (<em>${application.credentials}</em>) has been <strong>approved</strong> by the WellMindly team!</p>
              <p>Please click the button below to complete your registration, set up your account password, and configure your counselor profile & availability slots:</p>
              <p style="margin: 28px 0;">
                <a href="${setupUrl}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);">Set Up Counselor Profile</a>
              </p>
              <p style="color: #64748b; font-size: 13px;">Direct Link: <a href="${setupUrl}" style="color: #4f46e5;">${setupUrl}</a></p>
              <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This invitation link will remain valid for 7 days.</p>
            </div>
          `,
            });
            // Record journey stage in audit log for tracking
            await prisma_1.default.auditLog.create({
                data: {
                    action: 'COUNSELOR_INVITE_SENT',
                    targetEntity: 'CounselorOnboarding',
                    targetId: id,
                    actorId: req.user?.sub || null,
                    details: {
                        approvedBy: req.user?.email || 'admin',
                        targetEmail: cleanEmail,
                        setupUrl,
                        timestamp: new Date().toISOString(),
                    },
                },
            });
            res.status(200).json({
                success: true,
                message: `Counselor application approved! Onboarding invitation emailed to ${cleanEmail}`,
                setupUrl,
                invitation,
            });
        }
        else {
            if (user.role !== 'COUNSELOR') {
                user = await prisma_1.default.user.update({
                    where: { id: user.id },
                    data: { role: 'COUNSELOR' },
                });
            }
            const existingProfile = await prisma_1.default.counselorProfile.findUnique({ where: { userId: user.id } });
            if (!existingProfile) {
                await prisma_1.default.counselorProfile.create({
                    data: {
                        userId: user.id,
                        credentials: application.credentials,
                        specializations: ['Youth Wellbeing', 'Mentorship'],
                        bio: application.experience || application.message,
                        phone: application.phone,
                        status: 'ACTIVE',
                    },
                });
            }
            await prisma_1.default.auditLog.create({
                data: {
                    action: 'COUNSELOR_ACTIVATED',
                    targetEntity: 'CounselorOnboarding',
                    targetId: id,
                    actorId: req.user?.sub || null,
                    details: {
                        approvedBy: req.user?.email || 'admin',
                        targetEmail: cleanEmail,
                        timestamp: new Date().toISOString(),
                    },
                },
            });
            res.status(200).json({
                success: true,
                message: `Counselor application approved! Account for ${cleanEmail} activated as Counselor.`,
            });
        }
    }
    catch (error) {
        console.error('Error approving counselor application:', error);
        res.status(500).json({ error: 'Failed to approve counselor application' });
    }
});
exports.default = router;
