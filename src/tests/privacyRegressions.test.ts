import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Everything here runs against a mocked Prisma client: no database is touched.
const db = vi.hoisted(() => ({
  university: { findUnique: vi.fn() },
  user: { findMany: vi.fn(), findUnique: vi.fn() },
  quizResult: { findMany: vi.fn() },
  talkNote: { findMany: vi.fn() },
  $executeRawUnsafe: vi.fn().mockResolvedValue(0),
}));

vi.mock('../lib/prisma', () => ({ default: db }));

const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock('../utils/mailer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/mailer')>();
  return { ...actual, sendEmail: mail.sendEmail };
});

import app from '../app';
import { signToken } from '../lib/jwt';

const tokenFor = (role: string, universityId: string | null = null) =>
  signToken({ sub: `${role.toLowerCase()}-1`, email: `${role.toLowerCase()}@example.test`, role, universityId });

// Mirrors what POST /api/quizzes/submit stores in QuizResult.classification.
const storedBlob = (label: string, i: number) =>
  JSON.stringify({
    classification: label,
    aiFeedback: { headline: `private headline ${i}`, narrative: 'private narrative' },
    answers: { responses: [i, 3, 4], summary: label },
  });

function mockUniversityWithStudents(studentCount: number) {
  db.university.findUnique.mockResolvedValue({ id: 'uni-1', name: 'Test U', domain: 'u.test', verified: true });
  const students = Array.from({ length: studentCount }, (_, i) => ({ id: `s${i}` }));
  db.user.findMany.mockResolvedValue(students);
  db.quizResult.findMany.mockResolvedValue(
    students.map((s, i) => ({
      id: `r${i}`,
      userId: s.id,
      quizId: 'q1',
      overallScore: 10 + i,
      completedAt: new Date('2026-11-01T10:00:00Z'),
      classification: storedBlob(i % 2 ? 'Steady' : 'Doing Well', i),
      quiz: { id: 'q1', title: 'Emotional check-in', category: 'Wellbeing', maxScore: 35 },
    }))
  );
}

describe('University metrics privacy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('groups by the band label only, never by the stored answers/feedback blob', async () => {
    mockUniversityWithStudents(6);
    const res = await request(app).get('/api/university/metrics').set('Authorization', `Bearer ${tokenFor('UNIVERSITY', 'uni-1')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppressed).toBe(false);
    const labels = res.body.classificationDistribution.map((d: any) => d.label).sort();
    expect(labels).toEqual(['Doing Well', 'Steady']);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('private headline');
    expect(body).not.toContain('responses');
    // Per-quiz extremes are one student's score, so they are never sent.
    expect(res.body.quizMetrics[0].minScore).toBeNull();
    expect(res.body.quizMetrics[0].maxObservedScore).toBeNull();
  });

  it('suppresses breakdowns for a cohort smaller than the minimum size', async () => {
    mockUniversityWithStudents(2);
    const res = await request(app).get('/api/university/metrics').set('Authorization', `Bearer ${tokenFor('UNIVERSITY', 'uni-1')}`);

    expect(res.status).toBe(200);
    expect(res.body.suppressed).toBe(true);
    expect(res.body.classificationDistribution).toEqual([]);
    expect(res.body.quizMetrics).toEqual([]);
    expect(res.body.submissionTrend).toEqual([]);
    expect(res.body.clusterAverage).toBe(0);
  });
});

describe('TalkMindly role gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['UNIVERSITY', 'COUNSELOR'])('refuses a %s token on peer posts', async (role) => {
    const res = await request(app).get('/api/talk/rooms/room-1/notes').set('Authorization', `Bearer ${tokenFor(role)}`);
    expect(res.status).toBe(403);
    expect(db.talkNote.findMany).not.toHaveBeenCalled();
  });

  it('still lets a student read peer posts', async () => {
    db.talkNote.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/talk/rooms/room-1/notes').set('Authorization', `Bearer ${tokenFor('STUDENT')}`);
    expect(res.status).toBe(200);
  });
});

describe('Auth and upload hardening', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks a sign-up code after 5 wrong guesses', async () => {
    db.user.findUnique.mockResolvedValue(null);
    mail.sendEmail.mockResolvedValue(true);
    const email = 'otp-lock@example.test';
    expect((await request(app).post('/api/auth/send-otp').send({ email })).status).toBe(200);

    const attempt = (otp: string) =>
      request(app).post('/api/auth/register').send({ email, password: 'longenough1', firstName: 'A', lastName: 'B', otp });

    for (let i = 0; i < 4; i++) expect((await attempt('000000')).body.error).toBe('Incorrect verification code');
    expect((await attempt('000000')).body.error).toMatch(/Too many incorrect attempts/);
    expect((await attempt('000000')).body.error).toBe('Please request a verification code first');
  });

  it('never BCCs a sign-up code, and reports a failed send instead of claiming success', async () => {
    db.user.findUnique.mockResolvedValue(null);
    mail.sendEmail.mockResolvedValue(false);
    const res = await request(app).post('/api/auth/send-otp').send({ email: 'nosend@example.test' });
    expect(res.status).toBe(503);
    const opts = mail.sendEmail.mock.calls[0][0];
    expect(opts.sensitive).toBe(true);
    expect(opts.bcc).toBeUndefined();
  });

  it('answers forgot-password the same way for unknown addresses', async () => {
    db.user.findUnique.mockResolvedValue(null);
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.test' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/If an account exists/);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('rejects an SVG avatar upload', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    const res = await request(app)
      .post('/api/v1/counselors/me/upload')
      .set('Authorization', `Bearer ${tokenFor('COUNSELOR')}`)
      .send({ base64Data: svg, mimeType: 'image/svg+xml', fileName: 'x.svg', folder: '../../src' });
    expect(res.status).toBe(400);
  });

  it('keeps the chat diagnostics endpoint away from anonymous callers', async () => {
    expect((await request(app).get('/api/chat/diagnose')).status).toBe(401);
  });
});

describe('SUPER_ADMIN satisfies ADMIN checks', () => {
  const run = (mw: any, role: string) => {
    let status = 0;
    let passed = false;
    const res: any = { status: (s: number) => ((status = s), res), json: () => res };
    mw({ user: { role } } as any, res, () => (passed = true));
    return passed ? 'next' : status;
  };

  it('in authorizeRoles (legacy routes)', async () => {
    const { authorizeRoles } = await import('../utils/jwt');
    expect(run(authorizeRoles('ADMIN'), 'SUPER_ADMIN')).toBe('next');
    expect(run(authorizeRoles('ADMIN'), 'UNIVERSITY')).toBe(403);
    expect(run(authorizeRoles('STUDENT'), 'SUPER_ADMIN')).toBe(403);
  });

  it('in requireRoles (v1 routes)', async () => {
    const { requireRoles } = await import('../middleware/rbac');
    expect(run(requireRoles(['ADMIN'] as any), 'SUPER_ADMIN')).toBe('next');
    expect(run(requireRoles(['ADMIN'] as any), 'COUNSELOR')).toBe(403);
  });
});
