import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const JWKS_TTL_MS = 60 * 60 * 1000;
const MIN_REFETCH_MS = 60 * 1000;

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n?: string;
  e?: string;
}

let cache: { keys: Jwk[]; fetchedAt: number } | null = null;

export type JwksFetcher = () => Promise<Jwk[]>;

async function fetchAppleKeys(): Promise<Jwk[]> {
  const res = await fetch(APPLE_JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Apple JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
}

let fetcher: JwksFetcher = fetchAppleKeys;

/** Test hook: replace the network fetch and clear the cache. */
export function __setAppleJwksFetcher(f: JwksFetcher | null): void {
  fetcher = f ?? fetchAppleKeys;
  cache = null;
}

async function getKey(kid: string): Promise<Jwk | undefined> {
  const fresh = cache && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
  if (fresh) {
    const hit = cache!.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  // Unknown kid or stale cache: refetch (handles Apple key rotation), but at
  // most once a minute so junk `kid` values cannot hammer Apple's endpoint.
  if (cache && Date.now() - cache.fetchedAt < MIN_REFETCH_MS) return undefined;
  const keys = await fetcher();
  cache = { keys, fetchedAt: Date.now() };
  return keys.find((k) => k.kid === kid);
}

export interface AppleIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
  isPrivateEmail: boolean;
}

/**
 * Verifies an Apple identity token: RS256 signature against Apple's JWKS,
 * issuer, expiry and audience (the app's bundle ID, plus any extra IDs).
 * Throws on any failure.
 */
export async function verifyAppleIdentityToken(
  idToken: string,
  audiences: string[],
  expectedNonce: string
): Promise<AppleIdentity> {
  const decoded = jwt.decode(idToken, { complete: true });
  const kid = decoded && typeof decoded === 'object' ? (decoded.header as any)?.kid : undefined;
  if (!kid) throw new Error('Apple token has no key id');

  const jwk = await getKey(kid);
  if (!jwk) throw new Error('Apple signing key not found');

  const publicKey = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    audience: audiences as [string, ...string[]],
  }) as jwt.JwtPayload;

  if (!payload.sub) throw new Error('Apple token has no subject');

  // The nonce is mandatory: it binds the token to this sign-in attempt, so a
  // captured token cannot simply be replayed. Apple embeds the nonce as given
  // by the client, or its SHA-256 hex digest.
  if (!expectedNonce) throw new Error('Apple sign-in nonce is required');
  const hashed = crypto.createHash('sha256').update(expectedNonce).digest('hex');
  if (payload.nonce !== expectedNonce && payload.nonce !== hashed) {
    throw new Error('Apple token nonce mismatch');
  }

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    isPrivateEmail: payload.is_private_email === true || payload.is_private_email === 'true',
  };
}
