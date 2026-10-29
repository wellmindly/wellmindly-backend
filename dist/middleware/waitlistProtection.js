"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetRateLimitStoresForTesting = resetRateLimitStoresForTesting;
exports.normalizeEmail = normalizeEmail;
exports.isValidEmailSyntax = isValidEmailSyntax;
exports.getClientIp = getClientIp;
exports.waitlistProtectionMiddleware = waitlistProtectionMiddleware;
const env_1 = require("../config/env");
const waitlistLogger_1 = require("../utils/waitlistLogger");
// In-memory sliding window rate limit stores
const ipRateLimitStore = new Map();
const emailRateLimitStore = new Map();
// Periodic cleanup of expired rate limit entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of ipRateLimitStore.entries()) {
        if (bucket.resetAt <= now)
            ipRateLimitStore.delete(key);
    }
    for (const [key, bucket] of emailRateLimitStore.entries()) {
        if (bucket.resetAt <= now)
            emailRateLimitStore.delete(key);
    }
}, 5 * 60 * 1000).unref();
function resetRateLimitStoresForTesting() {
    ipRateLimitStore.clear();
    emailRateLimitStore.clear();
}
/**
 * Normalizes email address consistently: trims whitespace, removes control characters, converts to lowercase.
 */
function normalizeEmail(email) {
    if (typeof email !== 'string')
        return '';
    return email.trim().toLowerCase();
}
/**
 * Strict RFC 5322-compliant email syntax validation on backend
 */
function isValidEmailSyntax(email) {
    if (typeof email !== 'string')
        return false;
    const trimmed = normalizeEmail(email);
    if (!trimmed || trimmed.length > 254)
        return false;
    // RFC 5322 official standard regex subset
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!emailRegex.test(trimmed))
        return false;
    const parts = trimmed.split('@');
    if (parts.length !== 2)
        return false;
    const [localPart, domain] = parts;
    if (localPart.length > 64 || domain.length > 253)
        return false;
    if (domain.startsWith('-') || domain.endsWith('-'))
        return false;
    return true;
}
/**
 * Extracts client IP respecting reverse proxies (CloudFront / ALB / Nginx)
 */
function getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
        return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded[0]) {
        return forwarded[0].split(',')[0].trim();
    }
    return req.ip || req.socket.remoteAddress || '127.0.0.1';
}
/**
 * Layered Bot and Rate Limit Protection Middleware for Waitlist & Newsletter
 */
async function waitlistProtectionMiddleware(req, res, next) {
    const requestId = (0, waitlistLogger_1.generateRequestId)();
    const clientIp = getClientIp(req);
    const now = Date.now();
    const windowMs = env_1.env.WAITLIST_RATE_LIMIT_WINDOW_MS;
    const ipMax = env_1.env.WAITLIST_RATE_LIMIT_IP_MAX;
    const emailMax = env_1.env.WAITLIST_RATE_LIMIT_EMAIL_MAX;
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
    const normEmail = normalizeEmail(rawEmail);
    const campaign = req.body?.subject || req.body?.campaign || 'Waitlist';
    // Attach requestId and normEmail to request for downstream handlers
    req.requestId = requestId;
    req.normalizedEmail = normEmail;
    // 1. Bot Honeypot Check:
    // If hidden honeypot fields 'hp_confirm' or 'website' are filled, automated spambot detected.
    const honeypot = req.body?.hp_confirm || req.body?.website;
    if (honeypot && String(honeypot).trim() !== '') {
        (0, waitlistLogger_1.logWaitlistEvent)('BOT_BLOCKED_HONEYPOT', {
            requestId,
            ip: clientIp,
            email: normEmail,
            campaign,
            reason: 'Honeypot field populated by bot',
        });
        // Silent generic success response so bots cannot adapt
        res.status(200).json({
            success: true,
            message: 'Thank you for your interest! Please check your email to confirm your subscription.',
        });
        return;
    }
    // 2. Minimum Form Dwell Time Check:
    // Bots submit in < 1000ms. If _t is present and dwell < 1000ms, drop safely.
    if (req.body?._t) {
        const dwellMs = now - Number(req.body._t);
        if (dwellMs >= 0 && dwellMs < 1000) {
            (0, waitlistLogger_1.logWaitlistEvent)('BOT_BLOCKED_TIMING', {
                requestId,
                ip: clientIp,
                email: normEmail,
                campaign,
                dwellTimeMs: dwellMs,
                reason: 'Form submitted unnaturally fast (< 1000ms)',
            });
            res.status(200).json({
                success: true,
                message: 'Thank you for your interest! Please check your email to confirm your subscription.',
            });
            return;
        }
    }
    // 3. Optional CAPTCHA Verification (Turnstile / reCAPTCHA) if secret key configured
    if (env_1.env.CAPTCHA_SECRET_KEY && req.body?.captchaToken) {
        try {
            const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    secret: env_1.env.CAPTCHA_SECRET_KEY,
                    response: req.body.captchaToken,
                    remoteip: clientIp,
                }),
            });
            const verifyData = (await verifyRes.json());
            if (!verifyData.success) {
                (0, waitlistLogger_1.logWaitlistEvent)('BOT_BLOCKED_CHALLENGE', {
                    requestId,
                    ip: clientIp,
                    email: normEmail,
                    campaign,
                    reason: 'CAPTCHA challenge failed',
                });
                res.status(400).json({ success: false, error: 'Bot challenge verification failed.' });
                return;
            }
        }
        catch (err) {
            console.error('CAPTCHA verification service error:', err.message);
        }
    }
    // 4. IP-based Rate Limiting (Campus NAT-friendly window)
    let ipBucket = ipRateLimitStore.get(clientIp);
    if (!ipBucket || ipBucket.resetAt <= now) {
        ipBucket = { count: 1, resetAt: now + windowMs };
        ipRateLimitStore.set(clientIp, ipBucket);
    }
    else {
        ipBucket.count++;
    }
    if (ipBucket.count > ipMax) {
        (0, waitlistLogger_1.logWaitlistEvent)('RATE_LIMIT_EXCEEDED', {
            requestId,
            ip: clientIp,
            email: normEmail,
            campaign,
            reason: `Exceeded IP limit of ${ipMax} requests per ${windowMs / 60000}m`,
        });
        const retryAfterSec = Math.ceil((ipBucket.resetAt - now) / 1000);
        res.setHeader('Retry-After', String(retryAfterSec));
        res.status(429).json({
            success: false,
            error: 'Too many requests from your network. Please try again in a few minutes.',
        });
        return;
    }
    // 5. Normalized Email-based Rate Limiting (Protects specific addresses from being spammed)
    if (normEmail) {
        let emailBucket = emailRateLimitStore.get(normEmail);
        if (!emailBucket || emailBucket.resetAt <= now) {
            emailBucket = { count: 1, resetAt: now + windowMs };
            emailRateLimitStore.set(normEmail, emailBucket);
        }
        else {
            emailBucket.count++;
        }
        if (emailBucket.count > emailMax) {
            (0, waitlistLogger_1.logWaitlistEvent)('RATE_LIMIT_EXCEEDED', {
                requestId,
                ip: clientIp,
                email: normEmail,
                campaign,
                reason: `Exceeded Email limit of ${emailMax} requests per ${windowMs / 60000}m`,
            });
            const retryAfterSec = Math.ceil((emailBucket.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfterSec));
            res.status(429).json({
                success: false,
                error: 'Too many subscription attempts for this email address. Please try again later.',
            });
            return;
        }
    }
    next();
}
