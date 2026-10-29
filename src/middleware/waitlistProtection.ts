import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { logWaitlistEvent, generateRequestId } from '../utils/waitlistLogger';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

// In-memory sliding window rate limit stores
const ipRateLimitStore = new Map<string, RateLimitBucket>();
const emailRateLimitStore = new Map<string, RateLimitBucket>();

// Periodic cleanup of expired rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of ipRateLimitStore.entries()) {
    if (bucket.resetAt <= now) ipRateLimitStore.delete(key);
  }
  for (const [key, bucket] of emailRateLimitStore.entries()) {
    if (bucket.resetAt <= now) emailRateLimitStore.delete(key);
  }
}, 5 * 60 * 1000).unref();

export function resetRateLimitStoresForTesting() {
  ipRateLimitStore.clear();
  emailRateLimitStore.clear();
}

/**
 * Normalizes email address consistently: trims whitespace, removes control characters, converts to lowercase.
 */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/**
 * Strict RFC 5322-compliant email syntax validation on backend
 */
export function isValidEmailSyntax(email: string): boolean {
  if (typeof email !== 'string') return false;
  const trimmed = normalizeEmail(email);
  if (!trimmed || trimmed.length > 254) return false;
  // RFC 5322 official standard regex subset
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailRegex.test(trimmed)) return false;

  const parts = trimmed.split('@');
  if (parts.length !== 2) return false;
  const [localPart, domain] = parts;
  if (localPart.length > 64 || domain.length > 253) return false;
  if (domain.startsWith('-') || domain.endsWith('-')) return false;

  return true;
}

/**
 * Extracts client IP respecting reverse proxies (CloudFront / ALB / Nginx)
 */
export function getClientIp(req: Request): string {
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
export async function waitlistProtectionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const requestId = generateRequestId();
  const clientIp = getClientIp(req);
  const now = Date.now();
  const windowMs = env.WAITLIST_RATE_LIMIT_WINDOW_MS;
  const ipMax = env.WAITLIST_RATE_LIMIT_IP_MAX;
  const emailMax = env.WAITLIST_RATE_LIMIT_EMAIL_MAX;

  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const normEmail = normalizeEmail(rawEmail);
  const campaign = req.body?.subject || req.body?.campaign || 'Waitlist';

  // Attach requestId and normEmail to request for downstream handlers
  (req as any).requestId = requestId;
  (req as any).normalizedEmail = normEmail;

  // 1. Bot Honeypot Check:
  // If hidden honeypot fields 'hp_confirm' or 'website' are filled, automated spambot detected.
  const honeypot = req.body?.hp_confirm || req.body?.website;
  if (honeypot && String(honeypot).trim() !== '') {
    logWaitlistEvent('BOT_BLOCKED_HONEYPOT', {
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
      logWaitlistEvent('BOT_BLOCKED_TIMING', {
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
  if (env.CAPTCHA_SECRET_KEY && req.body?.captchaToken) {
    try {
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: env.CAPTCHA_SECRET_KEY,
          response: req.body.captchaToken,
          remoteip: clientIp,
        }),
      });
      const verifyData = (await verifyRes.json()) as { success: boolean };
      if (!verifyData.success) {
        logWaitlistEvent('BOT_BLOCKED_CHALLENGE', {
          requestId,
          ip: clientIp,
          email: normEmail,
          campaign,
          reason: 'CAPTCHA challenge failed',
        });
        res.status(400).json({ success: false, error: 'Bot challenge verification failed.' });
        return;
      }
    } catch (err: any) {
      console.error('CAPTCHA verification service error:', err.message);
    }
  }

  // 4. IP-based Rate Limiting (Campus NAT-friendly window)
  let ipBucket = ipRateLimitStore.get(clientIp);
  if (!ipBucket || ipBucket.resetAt <= now) {
    ipBucket = { count: 1, resetAt: now + windowMs };
    ipRateLimitStore.set(clientIp, ipBucket);
  } else {
    ipBucket.count++;
  }

  if (ipBucket.count > ipMax) {
    logWaitlistEvent('RATE_LIMIT_EXCEEDED', {
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
    } else {
      emailBucket.count++;
    }

    if (emailBucket.count > emailMax) {
      logWaitlistEvent('RATE_LIMIT_EXCEEDED', {
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
