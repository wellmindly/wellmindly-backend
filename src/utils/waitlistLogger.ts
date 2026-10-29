import crypto from 'crypto';

export type WaitlistEventType =
  | 'SUBSCRIPTION_ATTEMPT'
  | 'SUBSCRIPTION_CREATED'
  | 'DUPLICATE_PREVENTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'BOT_BLOCKED_HONEYPOT'
  | 'BOT_BLOCKED_TIMING'
  | 'BOT_BLOCKED_CHALLENGE'
  | 'VERIFICATION_EMAIL_SENT'
  | 'VERIFICATION_EMAIL_FAILED'
  | 'VERIFICATION_SUCCESS'
  | 'VERIFICATION_FAILED_EXPIRED'
  | 'VERIFICATION_FAILED_INVALID'
  | 'VERIFICATION_ALREADY_CONFIRMED'
  | 'RESEND_VERIFICATION_SENT'
  | 'RESEND_VERIFICATION_IGNORED';

export interface LogEventDetails {
  requestId?: string;
  ip?: string;
  email?: string;
  campaign?: string;
  reason?: string;
  dwellTimeMs?: number;
  [key: string]: unknown;
}

// In-memory operational metrics counters
class WaitlistMetrics {
  private attempts = 0;
  private duplicatesPrevented = 0;
  private verifiedCount = 0;
  private botRejections = 0;
  private rateLimitRejections = 0;
  private emailsSent = 0;
  private emailsFailed = 0;
  private uniqueEmailsEncountered = new Set<string>();

  public recordEvent(type: WaitlistEventType, details: LogEventDetails) {
    if (details.email) {
      this.uniqueEmailsEncountered.add(maskEmail(details.email));
    }

    switch (type) {
      case 'SUBSCRIPTION_ATTEMPT':
        this.attempts++;
        break;
      case 'DUPLICATE_PREVENTED':
        this.duplicatesPrevented++;
        break;
      case 'VERIFICATION_SUCCESS':
        this.verifiedCount++;
        break;
      case 'BOT_BLOCKED_HONEYPOT':
      case 'BOT_BLOCKED_TIMING':
      case 'BOT_BLOCKED_CHALLENGE':
        this.botRejections++;
        break;
      case 'RATE_LIMIT_EXCEEDED':
        this.rateLimitRejections++;
        break;
      case 'VERIFICATION_EMAIL_SENT':
      case 'RESEND_VERIFICATION_SENT':
        this.emailsSent++;
        break;
      case 'VERIFICATION_EMAIL_FAILED':
        this.emailsFailed++;
        break;
    }
  }

  public getSnapshot() {
    return {
      totalAttempts: this.attempts,
      uniqueSubscribersSeen: this.uniqueEmailsEncountered.size,
      confirmedVerified: this.verifiedCount,
      duplicatesPrevented: this.duplicatesPrevented,
      botRejections: this.botRejections,
      rateLimitRejections: this.rateLimitRejections,
      emailsSent: this.emailsSent,
      emailsFailed: this.emailsFailed,
      timestamp: new Date().toISOString(),
    };
  }

  public resetForTesting() {
    this.attempts = 0;
    this.duplicatesPrevented = 0;
    this.verifiedCount = 0;
    this.botRejections = 0;
    this.rateLimitRejections = 0;
    this.emailsSent = 0;
    this.emailsFailed = 0;
    this.uniqueEmailsEncountered.clear();
  }
}

export const waitlistMetrics = new WaitlistMetrics();

/**
 * Anonymizes email address for privacy-conscious logging:
 * e.g., 'student.alex@university.edu' -> 'st***@university.edu'
 */
export function maskEmail(email?: string): string {
  if (!email || !email.includes('@')) return 'anonymous@unknown';
  const [local, domain] = email.trim().toLowerCase().split('@');
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Anonymizes IP address by masking the last octet (IPv4) or segments (IPv6):
 */
export function maskIp(ip?: string): string {
  if (!ip) return '0.0.0.0';
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
    }
  }
  return ip.slice(0, 8) + '...';
}

/**
 * Generates a short correlation request ID if none exists:
 */
export function generateRequestId(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Privacy-conscious structured operational logger
 */
export function logWaitlistEvent(type: WaitlistEventType, details: LogEventDetails): void {
  waitlistMetrics.recordEvent(type, details);

  const payload = {
    timestamp: new Date().toISOString(),
    eventType: type,
    requestId: details.requestId || generateRequestId(),
    ip: maskIp(details.ip),
    email: details.email ? maskEmail(details.email) : undefined,
    campaign: details.campaign,
    reason: details.reason,
    dwellTimeMs: details.dwellTimeMs,
  };

  // Structured single-line JSON log for observability aggregators (CloudWatch, Datadog)
  console.log(`[WaitlistAudit] ${JSON.stringify(payload)}`);
}
