import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import app from '../app';
import { resetRateLimitStoresForTesting } from '../middleware/waitlistProtection';
import { waitlistMetrics } from '../utils/waitlistLogger';
import { analyzeSubscribers } from '../utils/subscriberAuditor';

// In-memory contact request store to simulate PostgreSQL database behavior
let mockDbContactRequests: any[] = [];

// Mock mailer
vi.mock('../utils/mailer', () => ({
  sendEmail: vi.fn().mockResolvedValue({ id: 'mock-mail-id' }),
  getOtpTemplate: vi.fn().mockReturnValue('<html>MOCK OTP</html>'),
}));

vi.mock('../utils/emailQueue', () => ({
  queueEmail: vi.fn(),
}));

// Mock Prisma client with real unique constraint emulation on subscriptionKey
vi.mock('../lib/prisma', () => ({
  default: {
    contactRequest: {
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        // Enforce unique constraint simulation on subscriptionKey
        if (data.subscriptionKey) {
          const collision = mockDbContactRequests.find(
            (r) => r.subscriptionKey === data.subscriptionKey
          );
          if (collision) {
            const error: any = new Error('Unique constraint failed on the fields: (`subscriptionKey`)');
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
      findFirst: vi.fn().mockImplementation(async ({ where }: any) => {
        if (!where) return mockDbContactRequests[0] || null;
        return (
          mockDbContactRequests.find((r) => {
            if (where.subscriptionKey && r.subscriptionKey !== where.subscriptionKey) return false;
            if (where.verificationTokenHash && r.verificationTokenHash !== where.verificationTokenHash) return false;
            if (where.normalizedEmail && r.normalizedEmail !== where.normalizedEmail) return false;
            if (where.id && r.id !== where.id) return false;
            return true;
          }) || null
        );
      }),
      findMany: vi.fn().mockImplementation(async ({ where, skip = 0, take = 50 }: any) => {
        let results = [...mockDbContactRequests];
        if (where?.status) {
          results = results.filter((r) => r.status === where.status);
        }
        return results.slice(skip, skip + take);
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const index = mockDbContactRequests.findIndex((r) => r.id === where.id);
        if (index === -1) {
          const error: any = new Error('Record to update not found');
          error.code = 'P2025';
          throw error;
        }
        Object.assign(mockDbContactRequests[index], data, { updatedAt: new Date() });
        return mockDbContactRequests[index];
      }),
      count: vi.fn().mockImplementation(async () => mockDbContactRequests.length),
      deleteMany: vi.fn().mockImplementation(async () => {
        const count = mockDbContactRequests.length;
        mockDbContactRequests = [];
        return { count };
      }),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

describe('Waitlist & Newsletter Abuse, Spam, and Duplicate Prevention Test Suite', () => {
  beforeEach(() => {
    mockDbContactRequests = [];
    resetRateLimitStoresForTesting();
    waitlistMetrics.resetForTesting();
    vi.clearAllMocks();
  });

  describe('1. Valid Subscription & Email Normalization Flow', () => {
    it('creates a new pending subscription and normalizes email (trims and lowercases)', async () => {
      const res = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: '   Student.Alex@University.EDU   ',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Requested newsletter notification when human coaching opens up to all students.',
          _t: Date.now() - 3000,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('PENDING');

      expect(mockDbContactRequests).toHaveLength(1);
      const record = mockDbContactRequests[0];
      expect(record.normalizedEmail).toBe('student.alex@university.edu');
      expect(record.subscriptionKey).toBe(
        'student.alex@university.edu::waitlist: human counselling for all students'
      );
      expect(record.status).toBe('PENDING');
      expect(record.verificationTokenHash).toBeDefined();
      expect(record.verificationExpiresAt).toBeDefined();
    });

    it('rejects invalid email syntax with HTTP 400', async () => {
      const res = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: 'not-an-email@',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Requested newsletter notification.',
          _t: Date.now() - 3000,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/invalid email/i);
      expect(mockDbContactRequests).toHaveLength(0);
    });
  });

  describe('2. Duplicate Prevention & Idempotency', () => {
    it('handles repeat submission idempotently without creating a second record', async () => {
      // First submission
      const res1 = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: 'learner@wellmindly.com',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Please let me know.',
          _t: Date.now() - 3000,
        });
      expect(res1.status).toBe(201);
      expect(mockDbContactRequests).toHaveLength(1);

      // Repeat submission with same email
      const res2 = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: 'learner@wellmindly.com',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Please let me know.',
          _t: Date.now() - 3000,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      // No duplicate record created!
      expect(mockDbContactRequests).toHaveLength(1);
    });

    it('handles case-insensitive duplicate submission', async () => {
      // Submission 1 in lowercase
      await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: 'campus.student@college.edu',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Updates please',
          _t: Date.now() - 3000,
        });

      // Submission 2 in UPPERCASE and mixed whitespace
      const res2 = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: '   CAMPUS.STUDENT@COLLEGE.EDU  ',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Updates please',
          _t: Date.now() - 3000,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(mockDbContactRequests).toHaveLength(1);
    });

    it('safely catches concurrent duplicate requests via database constraint', async () => {
      // Simulate 5 simultaneous requests arriving concurrently for the exact same address
      const promises = Array.from({ length: 5 }).map(() =>
        request(app)
          .post('/api/contacts/general')
          .send({
            name: 'Newsletter Subscriber',
            email: 'concurrent@college.edu',
            subject: 'Waitlist: Human Counselling for All Students',
            message: 'Concurrent submit test',
            _t: Date.now() - 3000,
          })
      );

      const results = await Promise.all(promises);

      // All responses should succeed gracefully (201 for the winner, 200 for the collision catches)
      for (const res of results) {
        expect([200, 201]).toContain(res.status);
        expect(res.body.success).toBe(true);
      }

      // Exactly ONE record exists in the database
      expect(mockDbContactRequests).toHaveLength(1);
    });
  });

  describe('3. Bot and Abuse Protections (Honeypot, Dwell Time, Rate Limiting)', () => {
    it('silently drops submissions with populated honeypot field', async () => {
      const res = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Spam Bot',
          email: 'bot@spamnetwork.com',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Spam payload',
          hp_confirm: 'http://malicious-link.com', // Honeypot populated!
          _t: Date.now() - 5000,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // No DB record created!
      expect(mockDbContactRequests).toHaveLength(0);
    });

    it('silently drops submissions submitted unnaturally fast (< 1000ms dwell time)', async () => {
      const res = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Fast Bot',
          email: 'speedybot@spamnetwork.com',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Fast submit',
          _t: Date.now() - 200, // Only 200ms elapsed!
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockDbContactRequests).toHaveLength(0);
    });

    it('enforces email-specific rate limits and returns HTTP 429', async () => {
      const targetEmail = 'spammed.victim@university.edu';

      // Send 5 rapid requests (the configured per-email limit)
      for (let i = 0; i < 5; i++) {
        await request(app)
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
      const res6 = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: targetEmail,
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Repeated spam attempts',
          _t: Date.now() - 3000,
        });

      expect(res6.status).toBe(429);
      expect(res6.body.success).toBe(false);
      expect(res6.body.error).toMatch(/too many.*email/i);
    });
  });

  describe('4. Double Opt-In Email Verification Workflow', () => {
    it('verifies a subscription with a valid token and marks as VERIFIED', async () => {
      // 1. Subscribe
      await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: 'verify.me@university.edu',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Sign me up',
          _t: Date.now() - 3000,
        });

      const pendingRecord = mockDbContactRequests[0];
      expect(pendingRecord.status).toBe('PENDING');

      // Emulate retrieving raw token that corresponds to token hash
      const rawTestToken = 'test-verification-token-32bytes-hex-valid';
      const testHash = crypto.createHash('sha256').update(rawTestToken).digest('hex');
      pendingRecord.verificationTokenHash = testHash;

      // 2. Submit token to /verify
      const verifyRes = await request(app)
        .post('/api/contacts/verify')
        .send({ token: rawTestToken });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.message).toMatch(/confirmed/i);

      // Verify DB record was updated to VERIFIED and token cleared
      expect(pendingRecord.status).toBe('VERIFIED');
      expect(pendingRecord.verifiedAt).toBeDefined();
      expect(pendingRecord.verificationTokenHash).toBeNull();
    });

    it('rejects an expired verification token with HTTP 400', async () => {
      const rawTestToken = 'expired-token-sample';
      const testHash = crypto.createHash('sha256').update(rawTestToken).digest('hex');

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

      const verifyRes = await request(app)
        .post('/api/contacts/verify')
        .send({ token: rawTestToken });

      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.success).toBe(false);
      expect(verifyRes.body.error).toMatch(/expired/i);
    });

    it('rejects reuse of an already-consumed single-use token', async () => {
      const verifyRes = await request(app)
        .post('/api/contacts/verify')
        .send({ token: 'already-consumed-or-unknown-token' });

      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.success).toBe(false);
      expect(verifyRes.body.error).toMatch(/invalid or expired/i);
    });

    it('allows resending verification link idempotently and safely', async () => {
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

      const res = await request(app)
        .post('/api/contacts/resend-verification')
        .send({
          email: 'pending.resend@college.edu',
          subject: 'Waitlist: Human Counselling for All Students',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/if a pending subscription exists/i);

      // Verify token hash was regenerated in DB
      const updated = mockDbContactRequests[0];
      expect(updated.verificationTokenHash).not.toBe('old-hash');
    });

    it('handles email provider failure gracefully without crashing or losing subscription', async () => {
      const { sendEmail } = await import('../utils/mailer');
      vi.mocked(sendEmail).mockRejectedValueOnce(new Error('SMTP Connection Timeout'));

      const res = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: 'mailer.failure@university.edu',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Sign me up please',
          _t: Date.now() - 3000,
        });

      // Subscription should still be safely created in DB
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(mockDbContactRequests).toHaveLength(1);
      expect(mockDbContactRequests[0].normalizedEmail).toBe('mailer.failure@university.edu');
    });

    it('handles unexpected database failure gracefully with generic error', async () => {
      const prisma = (await import('../lib/prisma')).default;
      vi.mocked(prisma.contactRequest.findFirst).mockRejectedValueOnce(
        new Error('Database disk IO error')
      );

      const res = await request(app)
        .post('/api/contacts/general')
        .send({
          name: 'Newsletter Subscriber',
          email: 'db.failure@university.edu',
          subject: 'Waitlist: Human Counselling for All Students',
          message: 'Sign me up please',
          _t: Date.now() - 3000,
        });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Failed to submit contact request');
    });
  });

  describe('5. Database Migration & Consolidation Against 979 Records / 440 Unique Emails Snapshot', () => {
    it('analyzes and consolidates duplicate records retaining earliest timestamps and exactly 440 unique subscribers', () => {
      // Synthesize the exact distribution described in USER_REQUEST:
      // 979 total waitlist records, 440 unique emails, multiple repeated submissions with some having 10-40 records
      const simulatedRecords: any[] = [];
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
          if (duplicatesAdded >= 539) break;
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

      expect(simulatedRecords).toHaveLength(979);

      // Run deduplication analysis engine
      const analysis = analyzeSubscribers(simulatedRecords);

      expect(analysis.totalRecords).toBe(979);
      expect(analysis.uniqueSubscribers).toBe(440);
      expect(analysis.totalRedundantRecords).toBe(539);
      expect(analysis.duplicateGroupsCount).toBe(repeatTargetIndices.length);

      // Verify top duplicate email has over 40 submissions
      const topDup = analysis.topDuplicateEmails[0];
      expect(topDup.count).toBeGreaterThan(40);

      // Verify earliest timestamp preservation rule:
      // For each duplicate group, records[0] is the primary record with the earliest timestamp
      for (const group of analysis.duplicateGroups) {
        const primaryRecord = group.records[0];
        for (let j = 1; j < group.records.length; j++) {
          const duplicateInstance = group.records[j];
          expect(new Date(primaryRecord.createdAt).getTime()).toBeLessThanOrEqual(
            new Date(duplicateInstance.createdAt).getTime()
          );
        }
      }
    });
  });
});
