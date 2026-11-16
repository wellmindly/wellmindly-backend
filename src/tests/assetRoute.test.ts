import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('../lib/prisma', () => ({ default: {} }));

import app from '../app';

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Raw http.get with an explicit path: URL-based clients (supertest/fetch) normalise
// dot segments away before the request leaves, which would hide the bug.
function rawGet(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      })
      .on('error', reject);
  });
}

describe('counselor asset route hardening', () => {
  it('returns 404 for a ".." filename instead of streaming a directory', async () => {
    expect(await rawGet('/api/v1/counselors/assets/avatars/%2e%2e')).toBe(404);
  });

  it('returns 404 for a "." filename', async () => {
    expect(await rawGet('/api/v1/counselors/assets/avatars/%2e')).toBe(404);
  });

  it('keeps serving after a bad request', async () => {
    await rawGet('/api/v1/counselors/assets/avatars/%2e%2e');
    expect(await rawGet('/api/v1/counselors/assets/avatars/does-not-exist.png')).toBe(404);
  });
});

describe('trust proxy', () => {
  it('trusts a single hop, not the whole X-Forwarded-For chain', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});
