import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  userDelete: vi.fn(),
  sessionsDelete: vi.fn(),
  auditUpdate: vi.fn(),
  revoke: vi.fn(),
  exchange: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  default: {
    user: {
      findUnique: (a: any) => m.findUnique(a),
      findFirst: (a: any) => m.findFirst(a),
      update: (a: any) => m.update(a),
      delete: (a: any) => m.userDelete(a),
      create: vi.fn(),
    },
    counselorSession: { deleteMany: (a: any) => m.sessionsDelete(a) },
    auditLog: { updateMany: (a: any) => m.auditUpdate(a), create: vi.fn().mockResolvedValue({ id: 'a' }) },
    university: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('../lib/appleRevoke', () => ({
  revokeAppleToken: (t: string) => m.revoke(t),
  exchangeAppleAuthCode: (c: string) => m.exchange(c),
}));

vi.mock('../utils/mailer', async (orig) => ({
  ...((await orig()) as object),
  sendEmail: vi.fn().mockResolvedValue(true),
}));

import app from '../app';
import { signToken } from '../lib/jwt';
import { __setAppleJwksFetcher } from '../lib/appleAuth';

const user = { id: 'u1', email: 'stu@uni.edu', firstName: 'Stu', lastName: 'D', role: 'STUDENT', universityId: null };
const auth = () => ({
  Authorization: `Bearer ${signToken({ sub: 'u1', email: user.email, role: 'STUDENT', universityId: null } as any)}`,
});

describe('DELETE /api/auth/account: Apple token revocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findFirst.mockResolvedValue(user);
    m.userDelete.mockResolvedValue(user);
    m.revoke.mockResolvedValue(true);
  });

  it('revokes the stored Apple refresh token before deleting the user', async () => {
    m.findUnique.mockResolvedValue({ appleId: 'sub-1', appleRefreshToken: 'rt-1' });
    const res = await request(app).delete('/api/auth/account').set(auth());
    expect(res.status).toBe(200);
    expect(m.revoke).toHaveBeenCalledWith('rt-1');
    expect(m.revoke.mock.invocationCallOrder[0]).toBeLessThan(m.userDelete.mock.invocationCallOrder[0]);
  });

  it('does not call Apple for a non-Apple account', async () => {
    m.findUnique.mockResolvedValue({ appleId: null, appleRefreshToken: null });
    const res = await request(app).delete('/api/auth/account').set(auth());
    expect(res.status).toBe(200);
    expect(m.revoke).not.toHaveBeenCalled();
    expect(m.userDelete).toHaveBeenCalled();
  });

  it('does not call Apple for an Apple account with no stored token (e.g. revocation was not configured)', async () => {
    m.findUnique.mockResolvedValue({ appleId: 'sub-1', appleRefreshToken: null });
    const res = await request(app).delete('/api/auth/account').set(auth());
    expect(res.status).toBe(200);
    expect(m.revoke).not.toHaveBeenCalled();
    expect(m.userDelete).toHaveBeenCalled();
  });

  it('still deletes the account when Apple revocation fails', async () => {
    m.findUnique.mockResolvedValue({ appleId: 'sub-1', appleRefreshToken: 'rt-1' });
    m.revoke.mockResolvedValue(false);
    const res = await request(app).delete('/api/auth/account').set(auth());
    expect(res.status).toBe(200);
    expect(m.userDelete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});

describe('POST /api/auth/apple/callback: storing the refresh token', () => {
  let key: crypto.KeyObject;
  let jwk: any;

  beforeAll(() => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    key = pair.privateKey;
    jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'kid1', alg: 'RS256', use: 'sig' };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __setAppleJwksFetcher(async () => [jwk]);
    m.findUnique.mockResolvedValue({ ...user, appleId: 'sub-1' });
  });

  const idToken = () =>
    jwt.sign(
      { iss: 'https://appleid.apple.com', aud: 'com.wellmindly.app', sub: 'sub-1', email: user.email, email_verified: 'true', nonce: 'n1' },
      key,
      { algorithm: 'RS256', keyid: 'kid1', expiresIn: '5m' }
    );

  it('exchanges the authorization code and stores the refresh token', async () => {
    m.exchange.mockResolvedValue('rt-9');
    const res = await request(app).post('/api/auth/apple/callback').send({ idToken: idToken(), nonce: 'n1', authorizationCode: 'code-1' });
    expect(res.status).toBe(200);
    expect(m.exchange).toHaveBeenCalledWith('code-1');
    expect(m.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { appleRefreshToken: 'rt-9' } });
  });

  it('skips the exchange when the app sends no authorization code', async () => {
    const res = await request(app).post('/api/auth/apple/callback').send({ idToken: idToken(), nonce: 'n1' });
    expect(res.status).toBe(200);
    expect(m.exchange).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it('still signs in when the code exchange or the save fails', async () => {
    m.exchange.mockResolvedValueOnce(null);
    let res = await request(app).post('/api/auth/apple/callback').send({ idToken: idToken(), nonce: 'n1', authorizationCode: 'c' });
    expect(res.status).toBe(200);
    expect(m.update).not.toHaveBeenCalled();

    m.exchange.mockResolvedValueOnce('rt');
    m.update.mockRejectedValueOnce(new Error('db down'));
    res = await request(app).post('/api/auth/apple/callback').send({ idToken: idToken(), nonce: 'n1', authorizationCode: 'c' });
    expect(res.status).toBe(200);
  });
});
