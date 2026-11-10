import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mocked Prisma: no database is touched.
const db = vi.hoisted(() => ({
  counselorProfile: { findUnique: vi.fn() },
  counselorSession: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  counselorFeedback: { findUnique: vi.fn(), create: vi.fn() },
  sessionNote: { findFirst: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  $executeRawUnsafe: vi.fn().mockResolvedValue(0),
}));
vi.mock('../lib/prisma', () => ({ default: db }));

const queued = vi.hoisted(() => vi.fn());
vi.mock('../utils/emailQueue', () => ({ queueEmail: queued }));

import app from '../app';
import { signToken } from '../lib/jwt';

const counselorToken = signToken({ sub: 'c-user-1', email: 'c@example.test', role: 'COUNSELOR', universityId: null });
const HOUR = 60 * 60 * 1000;

const profile = { id: 'profile-1', userId: 'c-user-1', user: { firstName: 'Kriti', lastName: 'Sapra' } };
const sessionAt = (offsetMs: number, status = 'CONFIRMED', counselorId = 'profile-1') => ({
  id: 'sess-1',
  counselorId,
  studentId: 'stu-1',
  status,
  startTime: new Date(Date.now() + offsetMs),
  endTime: new Date(Date.now() + offsetMs + HOUR),
  deletedAt: null,
  student: { email: 's@example.test', firstName: 'Alice' },
});

const patchStatus = (body: any) =>
  request(app)
    .patch('/api/v1/counselors/me/sessions/sess-1/status')
    .set('Authorization', `Bearer ${counselorToken}`)
    .send(body);

describe('PATCH /api/v1/counselors/me/sessions/:id/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.counselorProfile.findUnique.mockResolvedValue(profile);
    db.counselorSession.updateMany.mockResolvedValue({ count: 1 });
    db.counselorSession.findUnique.mockImplementation(async () => ({ id: 'sess-1', status: 'X', cancellationReason: null }));
  });

  it('marks a started session completed', async () => {
    db.counselorSession.findFirst.mockResolvedValue(sessionAt(-HOUR / 2));
    const res = await patchStatus({ status: 'COMPLETED' });
    expect(res.status).toBe(200);
    expect(db.counselorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-1', status: 'CONFIRMED' } })
    );
  });

  it('refuses to complete or no-show a session that has not started', async () => {
    db.counselorSession.findFirst.mockResolvedValue(sessionAt(2 * HOUR));
    expect((await patchStatus({ status: 'COMPLETED' })).status).toBe(409);
    expect((await patchStatus({ status: 'NO_SHOW' })).status).toBe(409);
    expect(db.counselorSession.updateMany).not.toHaveBeenCalled();
  });

  it('cancels an upcoming session and emails the student', async () => {
    db.counselorSession.findFirst.mockResolvedValue(sessionAt(2 * HOUR));
    const res = await patchStatus({ status: 'CANCELLED_BY_COUNSELOR', reason: 'Unwell' });
    expect(res.status).toBe(200);
    expect(queued).toHaveBeenCalledWith(expect.objectContaining({ to: 's@example.test' }));
  });

  it('rejects invalid transitions and unknown statuses', async () => {
    db.counselorSession.findFirst.mockResolvedValue(sessionAt(-2 * HOUR, 'COMPLETED'));
    expect((await patchStatus({ status: 'CANCELLED_BY_COUNSELOR' })).status).toBe(409);
    expect((await patchStatus({ status: 'EXPIRED' })).status).toBe(400);
  });

  it("does not let a counselor touch another counselor's session", async () => {
    db.counselorSession.findFirst.mockResolvedValue(sessionAt(-HOUR / 2, 'CONFIRMED', 'someone-else'));
    expect((await patchStatus({ status: 'COMPLETED' })).status).toBe(404);
    expect(db.counselorSession.updateMany).not.toHaveBeenCalled();
  });
});

describe('Counselor feedback and draft notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.counselorProfile.findUnique.mockResolvedValue(profile);
  });

  it('rejects feedback for a session that has not happened yet', async () => {
    db.counselorSession.findUnique.mockResolvedValue(sessionAt(2 * HOUR));
    const res = await request(app)
      .post('/api/v1/counselors/me/sessions/sess-1/feedback')
      .set('Authorization', `Bearer ${counselorToken}`)
      .send({ rating: 4 });
    expect(res.status).toBe(400);
    expect(db.counselorFeedback.create).not.toHaveBeenCalled();
  });

  it('finalises a draft note, then refuses further edits', async () => {
    db.sessionNote.findFirst.mockResolvedValueOnce({ id: 'n1', isDraft: true });
    db.sessionNote.update.mockResolvedValue({ id: 'n1', isDraft: false });
    const put = (body: any) =>
      request(app)
        .put('/api/v1/counselors/me/sessions/sess-1/notes/n1')
        .set('Authorization', `Bearer ${counselorToken}`)
        .send(body);

    expect((await put({ content: 'final text', isDraft: false })).status).toBe(200);

    db.sessionNote.findFirst.mockResolvedValueOnce({ id: 'n1', isDraft: false });
    expect((await put({ content: 'changed' })).status).toBe(409);
  });
});
