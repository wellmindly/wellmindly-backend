"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const supertest_1 = __importDefault(require("supertest"));
const crypto_1 = __importDefault(require("crypto"));
const app_1 = __importDefault(require("../app"));
const waitlistProtection_1 = require("../middleware/waitlistProtection");
const waitlistLogger_1 = require("../utils/waitlistLogger");
const subscriberAuditor_1 = require("../utils/subscriberAuditor");
const subscriberClassifier_1 = require("../utils/subscriberClassifier");
// In-memory contact request store to simulate PostgreSQL database behavior
let mockDbContactRequests = [];
// Mock mailer
vitest_1.vi.mock('../utils/mailer', () => ({
    sendEmail: vitest_1.vi.fn().mockResolvedValue({ id: 'mock-mail-id' }),
    getOtpTemplate: vitest_1.vi.fn().mockReturnValue('<html>MOCK OTP</html>'),
}));
vitest_1.vi.mock('../utils/emailQueue', () => ({
    queueEmail: vitest_1.vi.fn(),
}));
// Mock Prisma client with real unique constraint emulation on subscriptionKey
vitest_1.vi.mock('../lib/prisma', () => ({
    default: {
        contactRequest: {
            create: vitest_1.vi.fn().mockImplementation(async ({ data }) => {
                // Enforce unique constraint simulation on subscriptionKey
                if (data.subscriptionKey) {
                    const collision = mockDbContactRequests.find((r) => r.subscriptionKey === data.subscriptionKey);
                    if (collision) {
                        const error = new Error('Unique constraint failed on the fields: (`subscriptionKey`)');
                        error.code = 'P2002';
                        error.meta = { target: ['subscriptionKey'] };
                        throw error;
                    }
                }
                const record = {
                    id: `cr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    name: data.name,
                    email: data.email,
                    normalizedEmail: data.normalizedEmail || data.email.toLowerCase().trim(),
                    subject: data.subject || null,
                    message: data.message,
                    status: data.status || 'VERIFIED',
                    verifiedAt: data.verifiedAt || null,
                    subscriptionKey: data.subscriptionKey || null,
                    verificationTokenHash: data.verificationTokenHash || null,
                    verificationExpiresAt: data.verificationExpiresAt || null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };
                mockDbContactRequests.push(record);
                return record;
            }),
            findFirst: vitest_1.vi.fn().mockImplementation(async ({ where }) => {
                if (!where)
                    return mockDbContactRequests[0] || null;
                return (mockDbContactRequests.find((r) => {
                    if (where.subscriptionKey && r.subscriptionKey !== where.subscriptionKey)
                        return false;
                    if (where.verificationTokenHash && r.verificationTokenHash !== where.verificationTokenHash)
                        return false;
                    if (where.normalizedEmail && r.normalizedEmail !== where.normalizedEmail)
                        return false;
                    if (where.id && r.id !== where.id)
                        return false;
                    return true;
                }) || null);
            }),
            findMany: vitest_1.vi.fn().mockImplementation(async ({ where, skip = 0, take = 50 }) => {
                let results = [...mockDbContactRequests];
                if (where?.status) {
                    results = results.filter((r) => r.status === where.status);
                }
                return results.slice(skip, skip + take);
            }),
            update: vitest_1.vi.fn().mockImplementation(async ({ where, data }) => {
                const index = mockDbContactRequests.findIndex((r) => r.id === where.id);
                if (index === -1) {
                    const error = new Error('Record to update not found');
                    error.code = 'P2025';
                    throw error;
                }
                Object.assign(mockDbContactRequests[index], data, { updatedAt: new Date() });
                return mockDbContactRequests[index];
            }),
            count: vitest_1.vi.fn().mockImplementation(async () => mockDbContactRequests.length),
            deleteMany: vitest_1.vi.fn().mockImplementation(async () => {
                const count = mockDbContactRequests.length;
                mockDbContactRequests = [];
                return { count };
            }),
        },
        user: {
            findFirst: vitest_1.vi.fn().mockResolvedValue(null),
            findUnique: vitest_1.vi.fn().mockResolvedValue(null),
        },
    },
}));
(0, vitest_1.describe)('Waitlist & Newsletter Abuse, Spam, and Duplicate Prevention Test Suite', () => {
    (0, vitest_1.beforeEach)(() => {
        mockDbContactRequests = [];
        (0, waitlistProtection_1.resetRateLimitStoresForTesting)();
        waitlistLogger_1.waitlistMetrics.resetForTesting();
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.describe)('1. Valid Subscription & Email Normalization Flow', () => {
        (0, vitest_1.it)('creates a new pending subscription and normalizes email (trims and lowercases)', async () => {
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: '   Student.Alex@University.EDU   ',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Requested newsletter notification when human coaching opens up to all students.',
                _t: Date.now() - 3000,
            });
            (0, vitest_1.expect)(res.status).toBe(201);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            (0, vitest_1.expect)(res.body.status).toBe('PENDING');
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(1);
            const record = mockDbContactRequests[0];
            (0, vitest_1.expect)(record.normalizedEmail).toBe('student.alex@university.edu');
            (0, vitest_1.expect)(record.subscriptionKey).toBe('student.alex@university.edu::waitlist: human counselling for all students');
            (0, vitest_1.expect)(record.status).toBe('PENDING');
            (0, vitest_1.expect)(record.verificationTokenHash).toBeDefined();
            (0, vitest_1.expect)(record.verificationExpiresAt).toBeDefined();
        });
        (0, vitest_1.it)('rejects invalid email syntax with HTTP 400', async () => {
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'not-an-email@',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Requested newsletter notification.',
                _t: Date.now() - 3000,
            });
            (0, vitest_1.expect)(res.status).toBe(400);
            (0, vitest_1.expect)(res.body.success).toBe(false);
            (0, vitest_1.expect)(res.body.error).toMatch(/invalid email/i);
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(0);
        });
    });
    (0, vitest_1.describe)('2. Duplicate Prevention & Idempotency', () => {
        (0, vitest_1.it)('handles repeat submission idempotently without creating a second record', async () => {
            // First submission
            const res1 = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'learner@wellmindly.com',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Please let me know.',
                _t: Date.now() - 3000,
            });
            (0, vitest_1.expect)(res1.status).toBe(201);
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(1);
            // Repeat submission with same email
            const res2 = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'learner@wellmindly.com',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Please let me know.',
                _t: Date.now() - 3000,
            });
            (0, vitest_1.expect)(res2.status).toBe(200);
            (0, vitest_1.expect)(res2.body.success).toBe(true);
            // No duplicate record created!
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(1);
        });
        (0, vitest_1.it)('handles case-insensitive duplicate submission', async () => {
            // Submission 1 in lowercase
            await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'campus.student@college.edu',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Updates please',
                _t: Date.now() - 3000,
            });
            // Submission 2 in UPPERCASE and mixed whitespace
            const res2 = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: '   CAMPUS.STUDENT@COLLEGE.EDU  ',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Updates please',
                _t: Date.now() - 3000,
            });
            (0, vitest_1.expect)(res2.status).toBe(200);
            (0, vitest_1.expect)(res2.body.success).toBe(true);
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(1);
        });
        (0, vitest_1.it)('safely catches concurrent duplicate requests via database constraint', async () => {
            // Simulate 5 simultaneous requests arriving concurrently for the exact same address
            const promises = Array.from({ length: 5 }).map(() => (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'concurrent@college.edu',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Concurrent submit test',
                _t: Date.now() - 3000,
            }));
            const results = await Promise.all(promises);
            // All responses should succeed gracefully (201 for the winner, 200 for the collision catches)
            for (const res of results) {
                (0, vitest_1.expect)([200, 201]).toContain(res.status);
                (0, vitest_1.expect)(res.body.success).toBe(true);
            }
            // Exactly ONE record exists in the database
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(1);
        });
    });
    (0, vitest_1.describe)('3. Bot and Abuse Protections (Honeypot, Dwell Time, Rate Limiting)', () => {
        (0, vitest_1.it)('silently drops submissions with populated honeypot field', async () => {
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Spam Bot',
                email: 'bot@spamnetwork.com',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Spam payload',
                hp_confirm: 'http://malicious-link.com', // Honeypot populated!
                _t: Date.now() - 5000,
            });
            (0, vitest_1.expect)(res.status).toBe(200);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            // No DB record created!
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(0);
        });
        (0, vitest_1.it)('silently drops submissions submitted unnaturally fast (< 1000ms dwell time)', async () => {
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Fast Bot',
                email: 'speedybot@spamnetwork.com',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Fast submit',
                _t: Date.now() - 200, // Only 200ms elapsed!
            });
            (0, vitest_1.expect)(res.status).toBe(200);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(0);
        });
        (0, vitest_1.it)('enforces email-specific rate limits and returns HTTP 429', async () => {
            const targetEmail = 'spammed.victim@university.edu';
            // Send 5 rapid requests (the configured per-email limit)
            for (let i = 0; i < 5; i++) {
                await (0, supertest_1.default)(app_1.default)
                    .post('/api/contacts/general')
                    .send({
                    name: 'Newsletter Subscriber',
                    email: targetEmail,
                    subject: 'Waitlist: Human Counselling for All Students',
                    message: 'Repeated spam attempts',
                    _t: Date.now() - 3000,
                });
            }
            // 6th request should hit rate limit
            const res6 = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: targetEmail,
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Repeated spam attempts',
                _t: Date.now() - 3000,
            });
            (0, vitest_1.expect)(res6.status).toBe(429);
            (0, vitest_1.expect)(res6.body.success).toBe(false);
            (0, vitest_1.expect)(res6.body.error).toMatch(/too many.*email/i);
        });
    });
    (0, vitest_1.describe)('4. Double Opt-In Email Verification Workflow', () => {
        (0, vitest_1.it)('verifies a subscription with a valid token and marks as VERIFIED', async () => {
            // 1. Subscribe
            await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'verify.me@university.edu',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Sign me up',
                _t: Date.now() - 3000,
            });
            const pendingRecord = mockDbContactRequests[0];
            (0, vitest_1.expect)(pendingRecord.status).toBe('PENDING');
            // Emulate retrieving raw token that corresponds to token hash
            const rawTestToken = 'test-verification-token-32bytes-hex-valid';
            const testHash = crypto_1.default.createHash('sha256').update(rawTestToken).digest('hex');
            pendingRecord.verificationTokenHash = testHash;
            // 2. Submit token to /verify
            const verifyRes = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/verify')
                .send({ token: rawTestToken });
            (0, vitest_1.expect)(verifyRes.status).toBe(200);
            (0, vitest_1.expect)(verifyRes.body.success).toBe(true);
            (0, vitest_1.expect)(verifyRes.body.message).toMatch(/confirmed/i);
            // Verify DB record was updated to VERIFIED and token cleared
            (0, vitest_1.expect)(pendingRecord.status).toBe('VERIFIED');
            (0, vitest_1.expect)(pendingRecord.verifiedAt).toBeDefined();
            (0, vitest_1.expect)(pendingRecord.verificationTokenHash).toBeNull();
        });
        (0, vitest_1.it)('rejects an expired verification token with HTTP 400', async () => {
            const rawTestToken = 'expired-token-sample';
            const testHash = crypto_1.default.createHash('sha256').update(rawTestToken).digest('hex');
            mockDbContactRequests.push({
                id: 'cr-expired',
                name: 'Newsletter Subscriber',
                email: 'expired@college.edu',
                normalizedEmail: 'expired@college.edu',
                status: 'PENDING',
                verificationTokenHash: testHash,
                verificationExpiresAt: new Date(Date.now() - 1000 * 60), // Expired 1 min ago!
                createdAt: new Date(Date.now() - 1000 * 60 * 60 * 25),
            });
            const verifyRes = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/verify')
                .send({ token: rawTestToken });
            (0, vitest_1.expect)(verifyRes.status).toBe(400);
            (0, vitest_1.expect)(verifyRes.body.success).toBe(false);
            (0, vitest_1.expect)(verifyRes.body.error).toMatch(/expired/i);
        });
        (0, vitest_1.it)('rejects reuse of an already-consumed single-use token', async () => {
            const verifyRes = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/verify')
                .send({ token: 'already-consumed-or-unknown-token' });
            (0, vitest_1.expect)(verifyRes.status).toBe(400);
            (0, vitest_1.expect)(verifyRes.body.success).toBe(false);
            (0, vitest_1.expect)(verifyRes.body.error).toMatch(/invalid or expired/i);
        });
        (0, vitest_1.it)('allows resending verification link idempotently and safely', async () => {
            mockDbContactRequests.push({
                id: 'cr-pending',
                name: 'Newsletter Subscriber',
                email: 'pending.resend@college.edu',
                normalizedEmail: 'pending.resend@college.edu',
                subject: 'Waitlist: Human Counselling for All Students',
                subscriptionKey: 'pending.resend@college.edu::waitlist: human counselling for all students',
                status: 'PENDING',
                verificationTokenHash: 'old-hash',
                verificationExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
                createdAt: new Date(),
            });
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/resend-verification')
                .send({
                email: 'pending.resend@college.edu',
                subject: 'Waitlist: Human Counselling for All Students',
            });
            (0, vitest_1.expect)(res.status).toBe(200);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            (0, vitest_1.expect)(res.body.message).toMatch(/if a pending subscription exists/i);
            // Verify token hash was regenerated in DB
            const updated = mockDbContactRequests[0];
            (0, vitest_1.expect)(updated.verificationTokenHash).not.toBe('old-hash');
        });
        (0, vitest_1.it)('handles email provider failure gracefully without crashing or losing subscription', async () => {
            const { sendEmail } = await Promise.resolve().then(() => __importStar(require('../utils/mailer')));
            vitest_1.vi.mocked(sendEmail).mockRejectedValueOnce(new Error('SMTP Connection Timeout'));
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'mailer.failure@university.edu',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Sign me up please',
                _t: Date.now() - 3000,
            });
            // Subscription should still be safely created in DB
            (0, vitest_1.expect)(res.status).toBe(201);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            (0, vitest_1.expect)(mockDbContactRequests).toHaveLength(1);
            (0, vitest_1.expect)(mockDbContactRequests[0].normalizedEmail).toBe('mailer.failure@university.edu');
        });
        (0, vitest_1.it)('handles unexpected database failure gracefully with generic error', async () => {
            const prisma = (await Promise.resolve().then(() => __importStar(require('../lib/prisma')))).default;
            vitest_1.vi.mocked(prisma.contactRequest.findFirst).mockRejectedValueOnce(new Error('Database disk IO error'));
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/contacts/general')
                .send({
                name: 'Newsletter Subscriber',
                email: 'db.failure@university.edu',
                subject: 'Waitlist: Human Counselling for All Students',
                message: 'Sign me up please',
                _t: Date.now() - 3000,
            });
            (0, vitest_1.expect)(res.status).toBe(500);
            (0, vitest_1.expect)(res.body.success).toBe(false);
            (0, vitest_1.expect)(res.body.error).toBe('Failed to submit contact request');
        });
    });
    (0, vitest_1.describe)('5. Database Migration & Consolidation Against 979 Records / 440 Unique Emails Snapshot', () => {
        (0, vitest_1.it)('analyzes and consolidates duplicate records retaining earliest timestamps and exactly 440 unique subscribers', () => {
            // Synthesize the exact distribution described in USER_REQUEST:
            // 979 total waitlist records, 440 unique emails, multiple repeated submissions with some having 10-40 records
            const simulatedRecords = [];
            const baseDate = new Date('2026-10-01T10:00:00Z').getTime();
            // Create 440 unique email identities
            for (let i = 1; i <= 440; i++) {
                const email = `student_${i}@university.edu`;
                simulatedRecords.push({
                    id: `rec-initial-${i}`,
                    name: 'Newsletter Subscriber',
                    email,
                    subject: 'Waitlist: Human Counselling for All Students',
                    message: 'Requested newsletter notification when human coaching opens up to all students.',
                    createdAt: new Date(baseDate + i * 60000),
                });
            }
            // Add duplicate records to bring total from 440 to 979 (539 duplicate entries)
            // Some email addresses submitted 10-40 times (e.g. spambots or looping scripts)
            const repeatTargetIndices = [1, 5, 12, 25, 40, 88, 100];
            let duplicatesAdded = 0;
            while (duplicatesAdded < 539) {
                for (const targetIdx of repeatTargetIndices) {
                    if (duplicatesAdded >= 539)
                        break;
                    const email = targetIdx % 2 === 0
                        ? `student_${targetIdx}@university.edu`.toUpperCase() // Test case-insensitivity
                        : `  student_${targetIdx}@university.edu  `; // Test whitespace
                    duplicatesAdded++;
                    simulatedRecords.push({
                        id: `rec-dup-${duplicatesAdded}`,
                        name: 'Newsletter Subscriber',
                        email,
                        subject: 'Waitlist: Human Counselling for All Students',
                        message: 'Requested newsletter notification when human coaching opens up to all students.',
                        createdAt: new Date(baseDate + (440 + duplicatesAdded) * 60000),
                    });
                }
            }
            (0, vitest_1.expect)(simulatedRecords).toHaveLength(979);
            // Run deduplication analysis engine
            const analysis = (0, subscriberAuditor_1.analyzeSubscribers)(simulatedRecords);
            (0, vitest_1.expect)(analysis.totalRecords).toBe(979);
            (0, vitest_1.expect)(analysis.uniqueSubscribers).toBe(440);
            (0, vitest_1.expect)(analysis.totalRedundantRecords).toBe(539);
            (0, vitest_1.expect)(analysis.duplicateGroupsCount).toBe(repeatTargetIndices.length);
            // Verify top duplicate email has over 40 submissions
            const topDup = analysis.topDuplicateEmails[0];
            (0, vitest_1.expect)(topDup.count).toBeGreaterThan(40);
            // Verify earliest timestamp preservation rule:
            // For each duplicate group, records[0] is the primary record with the earliest timestamp
            for (const group of analysis.duplicateGroups) {
                const primaryRecord = group.records[0];
                for (let j = 1; j < group.records.length; j++) {
                    const duplicateInstance = group.records[j];
                    (0, vitest_1.expect)(new Date(primaryRecord.createdAt).getTime()).toBeLessThanOrEqual(new Date(duplicateInstance.createdAt).getTime());
                }
            }
        });
    });
    (0, vitest_1.describe)('Real vs Fake Subscriber Intelligent Classifier', () => {
        (0, vitest_1.it)('classifies legitimate university and human subscribers as REAL', () => {
            const realSamples = [
                'student@stanford.edu',
                'scholar@oxford.ac.uk',
                'counselling@iitb.ac.in',
                'frank.nienstedt@gmx.de',
                'claus@claus-gassner.de',
                'izabela.wegierkiewicz@gpd.com.pl',
                'stefanie-jung@t-online.de',
                'andreas.heese1977@googlemail.com',
                'luzia.zirondi@outlook.com',
                'marciarocha.ms@hotmail.com',
                'genesherman@earthlink.net',
            ];
            for (const email of realSamples) {
                const result = (0, subscriberClassifier_1.classifySubscriber)(email, 1);
                (0, vitest_1.expect)(result.isFake).toBe(false);
                (0, vitest_1.expect)(result.score).toBeLessThan(60);
            }
        });
        (0, vitest_1.it)('identifies automated CVCV syllable bot generators as FAKE', () => {
            const cvcBotSamples = [
                'ubavucuqepi58@gmail.com',
                'opufonezexa799@gmail.com',
                'fikiqonubu42@gmail.com',
                'licehajowe486@gmail.com',
                'yuqodujol509@gmail.com',
                'ipevumizob47@gmail.com',
                'ogabocom76@gmail.com',
                'uhayexal679@gmail.com',
            ];
            for (const email of cvcBotSamples) {
                const result = (0, subscriberClassifier_1.classifySubscriber)(email, 5);
                (0, vitest_1.expect)(result.isFake).toBe(true);
                (0, vitest_1.expect)(result.score).toBeGreaterThanOrEqual(60);
            }
        });
        (0, vitest_1.it)('identifies dot-trick spammers as FAKE', () => {
            const dotTrickSamples = [
                'a.ho.j.ujuy.i.ye.98@gmail.com',
                'f.iv.o.b.e.nuz.65@gmail.com',
                'a.d.ila.x.e.d.4.7@gmail.com',
                'mi.k.e.t.a.te.y.ou.n.g@gmail.com',
            ];
            for (const email of dotTrickSamples) {
                const result = (0, subscriberClassifier_1.classifySubscriber)(email, 1);
                (0, vitest_1.expect)(result.isFake).toBe(true);
                (0, vitest_1.expect)(result.reasons.some((r) => r.includes('Dot-trick'))).toBe(true);
            }
        });
        (0, vitest_1.it)('identifies unpronounceable keyboard mash and disposable domains as FAKE', () => {
            const mashSamples = [
                'ffreyyebrhggh@outlook.com',
                'gdvtgc@yahoo.com',
                'nhjldvovvwbimrc-60282@re.viremond.site',
            ];
            for (const email of mashSamples) {
                const result = (0, subscriberClassifier_1.classifySubscriber)(email, 1);
                (0, vitest_1.expect)(result.isFake).toBe(true);
            }
            const disposableResult = (0, subscriberClassifier_1.classifySubscriber)('bot@mailinator.com', 1);
            (0, vitest_1.expect)(disposableResult.isFake).toBe(true);
            (0, vitest_1.expect)(disposableResult.reasons.some((r) => r.includes('Disposable'))).toBe(true);
        });
    });
});
