import jwt from 'jsonwebtoken';
import { env } from '../config/env';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

export interface AppleRevokeConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  clientId: string;
}

/** Returns the config, or null when the Apple key env vars are not all set. */
export function getAppleRevokeConfig(): AppleRevokeConfig | null {
  if (!env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !env.APPLE_PRIVATE_KEY) return null;
  return {
    teamId: env.APPLE_TEAM_ID,
    keyId: env.APPLE_KEY_ID,
    // Env vars often carry the PEM with literal "\n".
    privateKey: env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientId: env.APPLE_BUNDLE_ID,
  };
}

/** Client secret for Apple's token endpoints: an ES256 JWT signed with the Sign in with Apple key. */
export function makeAppleClientSecret(cfg: AppleRevokeConfig): string {
  return jwt.sign({}, cfg.privateKey, {
    algorithm: 'ES256',
    keyid: cfg.keyId,
    issuer: cfg.teamId,
    audience: APPLE_AUDIENCE,
    subject: cfg.clientId,
    expiresIn: '5m',
  });
}

async function postForm(url: string, params: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(8000),
  });
}

/**
 * Exchanges the one-time authorization code from the iOS sign-in for a refresh
 * token. Returns null when revocation is not configured or the exchange fails
 * (sign-in must never fail because of this).
 */
export async function exchangeAppleAuthCode(code: string): Promise<string | null> {
  const cfg = getAppleRevokeConfig();
  if (!cfg) return null;
  try {
    const res = await postForm(TOKEN_URL, {
      client_id: cfg.clientId,
      client_secret: makeAppleClientSecret(cfg),
      code,
      grant_type: 'authorization_code',
    });
    if (!res.ok) {
      console.warn('Apple authorization code exchange failed:', res.status);
      return null;
    }
    const body = (await res.json()) as { refresh_token?: string };
    return typeof body.refresh_token === 'string' ? body.refresh_token : null;
  } catch (err: any) {
    console.warn('Apple authorization code exchange error:', err?.message || err);
    return null;
  }
}

/**
 * Revokes an Apple refresh token. Returns true on success. Never throws:
 * account deletion must still complete if Apple is unreachable.
 */
export async function revokeAppleToken(refreshToken: string): Promise<boolean> {
  const cfg = getAppleRevokeConfig();
  if (!cfg) return false;
  try {
    const res = await postForm(REVOKE_URL, {
      client_id: cfg.clientId,
      client_secret: makeAppleClientSecret(cfg),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
    if (!res.ok) console.warn('Apple token revocation failed:', res.status);
    return res.ok;
  } catch (err: any) {
    console.warn('Apple token revocation error:', err?.message || err);
    return false;
  }
}
