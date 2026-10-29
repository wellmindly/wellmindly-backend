"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.waitlistMetrics = void 0;
exports.maskEmail = maskEmail;
exports.maskIp = maskIp;
exports.generateRequestId = generateRequestId;
exports.logWaitlistEvent = logWaitlistEvent;
const crypto_1 = __importDefault(require("crypto"));
// In-memory operational metrics counters
class WaitlistMetrics {
    attempts = 0;
    duplicatesPrevented = 0;
    verifiedCount = 0;
    botRejections = 0;
    rateLimitRejections = 0;
    emailsSent = 0;
    emailsFailed = 0;
    uniqueEmailsEncountered = new Set();
    recordEvent(type, details) {
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
    getSnapshot() {
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
    resetForTesting() {
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
exports.waitlistMetrics = new WaitlistMetrics();
/**
 * Anonymizes email address for privacy-conscious logging:
 * e.g., 'student.alex@university.edu' -> 'st***@university.edu'
 */
function maskEmail(email) {
    if (!email || !email.includes('@'))
        return 'anonymous@unknown';
    const [local, domain] = email.trim().toLowerCase().split('@');
    if (local.length <= 2) {
        return `${local[0]}***@${domain}`;
    }
    return `${local.slice(0, 2)}***@${domain}`;
}
/**
 * Anonymizes IP address by masking the last octet (IPv4) or segments (IPv6):
 */
function maskIp(ip) {
    if (!ip)
        return '0.0.0.0';
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
function generateRequestId() {
    return crypto_1.default.randomBytes(8).toString('hex');
}
/**
 * Privacy-conscious structured operational logger
 */
function logWaitlistEvent(type, details) {
    exports.waitlistMetrics.recordEvent(type, details);
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
