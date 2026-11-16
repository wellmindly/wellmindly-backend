import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn() },
}));

vi.mock('../lib/prisma', () => ({ default: db }));

import app from '../app';
import { signToken } from '../lib/jwt';

const adminToken = () =>
  signToken({ sub: 'admin-1', email: 'admin@example.test', role: 'ADMIN', universityId: null });

describe('GET /api/admin/students/:id: credentials are never requested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.user.findFirst.mockResolvedValue(null);
  });

  it('omits every credential field, including the Apple refresh token', async () => {
    await request(app).get('/api/admin/students/s1').set('Authorization', `Bearer ${adminToken()}`);
    expect(db.user.findFirst).toHaveBeenCalledTimes(1);
    const args = db.user.findFirst.mock.calls[0][0];
    expect(args.omit).toMatchObject({
      passwordHash: true,
      googleId: true,
      appleId: true,
      appleRefreshToken: true,
    });
  });
});

describe('Prisma client defaults', () => {
  it('omits user.appleRefreshToken globally so queries must opt in', async () => {
    vi.resetModules();
    vi.doUnmock('../lib/prisma');
    const { prismaClientOptions } = await import('../lib/prisma');
    expect(prismaClientOptions.omit.user.appleRefreshToken).toBe(true);
  });
});
