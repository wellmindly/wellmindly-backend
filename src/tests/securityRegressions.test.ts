import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const mockUpsert = vi.fn();
const mockExecuteRaw = vi.fn();

vi.mock('../lib/prisma', () => ({
  default: {
    user: { upsert: (args: any) => mockUpsert(args) },
    university: { findFirst: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    $executeRawUnsafe: (...args: any[]) => mockExecuteRaw(...args),
  },
}));

import app from '../app';

describe('Security regressions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a forged (unsigned) Google ID token and never touches the DB', async () => {
    // Anyone can produce this: a JWT with an arbitrary email, signed with a
    // key that is not Google's. It must not log anyone in.
    const forged = jwt.sign(
      { sub: '123', email: 'admin@wellmindly.com', email_verified: true, aud: 'x', iss: 'accounts.google.com' },
      'attacker-secret'
    );

    const res = await request(app).post('/api/auth/google/callback').send({ idToken: forged });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.token).toBeUndefined();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects the old hardcoded maintenance key for the prod wipe endpoint', async () => {
    const res = await request(app)
      .post('/api/v1/admin/maintenance/wipe-prod-data')
      .set('x-maintenance-key', 'wellmindly_maint_2026_secure')
      .send({ confirm: 'CONFIRM_WIPE_PROD_DATA' });

    expect(res.status).toBe(401);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});
