import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const m = {
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  uniFind: vi.fn(),
  uniUnique: vi.fn(),
};

vi.mock('../lib/prisma', () => ({
  default: {
    user: {
      findUnique: (a: any) => m.findUnique(a),
      update: (a: any) => m.update(a),
      create: (a: any) => m.create(a),
      upsert: vi.fn(),
    },
    university: {
      findFirst: (a: any) => m.uniFind(a),
      findUnique: (a: any) => m.uniUnique(a),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a' }) },
  },
}));

import app from '../app';
import { __setAppleJwksFetcher } from '../lib/appleAuth';

const BUNDLE = 'com.wellmindly.app';
let privateKey: crypto.KeyObject;
let otherKey: crypto.KeyObject;
let jwk: any;

function sign(claims: Record<string, any>, opts: { key?: crypto.KeyObject; kid?: string } = {}) {
  return jwt.sign(
    { iss: 'https://appleid.apple.com', aud: BUNDLE, sub: 'apple-sub-1', email: 'stu@uni.edu', email_verified: 'true', ...claims },
    opts.key ?? privateKey,
    { algorithm: 'RS256', keyid: opts.kid ?? 'kid1', expiresIn: '5m', noTimestamp: false }
  );
}

const baseUser = {
  id: 'u1',
  email: 'stu@uni.edu',
  firstName: 'Stu',
  lastName: 'Dent',
  role: 'STUDENT',
  universityId: null,
};

describe('POST /api/auth/apple/callback', () => {
  beforeAll(() => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey;
    otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'kid1', alg: 'RS256', use: 'sig' };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    __setAppleJwksFetcher(async () => [jwk]);
    m.uniFind.mockResolvedValue(null);
    m.uniUnique.mockResolvedValue(null);
  });

  const post = (body: any) => request(app).post('/api/auth/apple/callback').send(body);

  it('400 without idToken', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('rejects a token signed with a key that is not Apple\'s', async () => {
    const res = await post({ idToken: sign({}, { key: otherKey }) });
    expect(res.status).toBe(401);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it('rejects the wrong audience', async () => {
    expect((await post({ idToken: sign({ aud: 'com.someone.else' }) })).status).toBe(401);
  });

  it('rejects the wrong issuer', async () => {
    expect((await post({ idToken: sign({ iss: 'https://evil.example.com' }) })).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const t = jwt.sign(
      { iss: 'https://appleid.apple.com', aud: BUNDLE, sub: 's', email: 'a@b.c', exp: Math.floor(Date.now() / 1000) - 60 },
      privateKey,
      { algorithm: 'RS256', keyid: 'kid1' }
    );
    expect((await post({ idToken: t })).status).toBe(401);
  });

  it('rejects an unsigned (alg none) token', async () => {
    const t = jwt.sign({ iss: 'https://appleid.apple.com', aud: BUNDLE, sub: 's', email: 'a@b.c' }, '', {
      algorithm: 'none',
      keyid: 'kid1',
    } as any);
    expect((await post({ idToken: t })).status).toBe(401);
  });

  it('rejects a nonce mismatch', async () => {
    const res = await post({ idToken: sign({ nonce: 'abc' }), nonce: 'different' });
    expect(res.status).toBe(401);
  });

  it('accepts a hashed nonce', async () => {
    const hashed = crypto.createHash('sha256').update('raw-nonce').digest('hex');
    m.findUnique.mockResolvedValueOnce({ ...baseUser });
    const res = await post({ idToken: sign({ nonce: hashed }), nonce: 'raw-nonce' });
    expect(res.status).toBe(200);
  });

  it('creates a new user on first sign-in, using the name sent by the client', async () => {
    m.findUnique.mockResolvedValue(null);
    m.create.mockResolvedValue({ ...baseUser, firstName: 'Asha', lastName: 'Rao' });
    const res = await post({ idToken: sign({}), firstName: 'Asha', lastName: 'Rao' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const data = m.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ email: 'stu@uni.edu', appleId: 'apple-sub-1', firstName: 'Asha', lastName: 'Rao', role: 'STUDENT' });
  });

  it('signs in a returning user by Apple sub even when Apple omits the email', async () => {
    m.findUnique.mockResolvedValueOnce({ ...baseUser });
    const res = await post({ idToken: sign({ email: undefined, email_verified: undefined }) });
    expect(res.status).toBe(200);
    expect(m.findUnique.mock.calls[0][0]).toEqual({ where: { appleId: 'apple-sub-1' } });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('links an existing email account to the Apple id', async () => {
    m.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...baseUser });
    m.update.mockResolvedValue({ ...baseUser });
    const res = await post({ idToken: sign({}) });
    expect(res.status).toBe(200);
    expect(m.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { appleId: 'apple-sub-1' } });
    expect(m.create).not.toHaveBeenCalled();
  });

  it('refuses to link or create on an unverified email', async () => {
    m.findUnique.mockResolvedValue(null);
    const res = await post({ idToken: sign({ email_verified: 'false' }) });
    expect(res.status).toBe(401);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('400 for an unknown Apple user with no email', async () => {
    m.findUnique.mockResolvedValue(null);
    const res = await post({ idToken: sign({ email: undefined, email_verified: undefined }) });
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });
});
