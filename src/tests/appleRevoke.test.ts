import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const cfgEnv = vi.hoisted(() => ({
  APPLE_TEAM_ID: undefined as string | undefined,
  APPLE_KEY_ID: undefined as string | undefined,
  APPLE_PRIVATE_KEY: undefined as string | undefined,
  APPLE_BUNDLE_ID: 'com.wellmindly.app',
}));

vi.mock('../config/env', () => ({ env: cfgEnv }));

import {
  getAppleRevokeConfig,
  makeAppleClientSecret,
  exchangeAppleAuthCode,
  revokeAppleToken,
} from '../lib/appleRevoke';

let pem: string;
let publicPem: string;

function configure() {
  cfgEnv.APPLE_TEAM_ID = 'TEAM123456';
  cfgEnv.APPLE_KEY_ID = 'KEY1234567';
  cfgEnv.APPLE_PRIVATE_KEY = pem;
}

describe('Apple token revocation', () => {
  const fetchMock = vi.fn();

  beforeAll(() => {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    cfgEnv.APPLE_TEAM_ID = undefined;
    cfgEnv.APPLE_KEY_ID = undefined;
    cfgEnv.APPLE_PRIVATE_KEY = undefined;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is disabled and makes no network call when the key env vars are missing', async () => {
    expect(getAppleRevokeConfig()).toBeNull();
    expect(await revokeAppleToken('rt')).toBe(false);
    expect(await exchangeAppleAuthCode('code')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays disabled when only some of the env vars are set', () => {
    cfgEnv.APPLE_TEAM_ID = 'TEAM123456';
    expect(getAppleRevokeConfig()).toBeNull();
  });

  it('builds a valid ES256 client secret with Apple\'s required claims', () => {
    configure();
    const secret = makeAppleClientSecret(getAppleRevokeConfig()!);
    const decoded = jwt.verify(secret, publicPem, { algorithms: ['ES256'], complete: true }) as any;
    expect(decoded.header.kid).toBe('KEY1234567');
    expect(decoded.payload).toMatchObject({
      iss: 'TEAM123456',
      aud: 'https://appleid.apple.com',
      sub: 'com.wellmindly.app',
    });
    expect(decoded.payload.exp - decoded.payload.iat).toBeLessThanOrEqual(300);
  });

  it('accepts a private key with literal \\n sequences (single-line env var)', () => {
    configure();
    cfgEnv.APPLE_PRIVATE_KEY = pem.replace(/\n/g, '\\n');
    const secret = makeAppleClientSecret(getAppleRevokeConfig()!);
    expect(() => jwt.verify(secret, publicPem, { algorithms: ['ES256'] })).not.toThrow();
  });

  it('exchanges an authorization code for a refresh token', async () => {
    configure();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ refresh_token: 'rt-1' }) });
    expect(await exchangeAppleAuthCode('auth-code')).toBe('rt-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://appleid.apple.com/auth/token');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    expect(body.get('client_id')).toBe('com.wellmindly.app');
    expect(body.get('client_secret')).toBeTruthy();
  });

  it('returns null (does not throw) when the code exchange is rejected or errors', async () => {
    configure();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    expect(await exchangeAppleAuthCode('bad')).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect(await exchangeAppleAuthCode('x')).toBeNull();
  });

  it('revokes a refresh token against Apple\'s revoke endpoint', async () => {
    configure();
    fetchMock.mockResolvedValue({ ok: true });
    expect(await revokeAppleToken('rt-1')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://appleid.apple.com/auth/revoke');
    const body = new URLSearchParams(init.body);
    expect(body.get('token')).toBe('rt-1');
    expect(body.get('token_type_hint')).toBe('refresh_token');
  });

  it('returns false (does not throw) when Apple rejects or is unreachable', async () => {
    configure();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
    expect(await revokeAppleToken('rt')).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    expect(await revokeAppleToken('rt')).toBe(false);
  });
});
