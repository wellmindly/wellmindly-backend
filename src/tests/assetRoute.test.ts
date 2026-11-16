import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';

vi.mock('../lib/prisma', () => ({ default: {} }));
// Local misses fall through to S3; keep tests offline.
vi.mock('../utils/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/s3')>()),
  getS3Object: vi.fn().mockResolvedValue(null),
}));

import express from 'express';
import app from '../app';
import { getClientIp } from '../middleware/waitlistProtection';

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

  it('still serves an avatar whose name starts with a dash', async () => {
    const uploads = path.join(process.cwd(), 'uploads');
    const dir = path.join(uploads, 'avatars');
    const file = path.join(dir, '-x.png');
    // Remember what we create so we can leave the tree exactly as we found it.
    const createdUploads = !fs.existsSync(uploads);
    const createdDir = !fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    try {
      expect(await rawGet('/api/v1/counselors/assets/avatars/-x.png')).toBe(200);
    } finally {
      fs.rmSync(file, { force: true });
      if (createdDir) fs.rmSync(dir, { recursive: true, force: true });
      if (createdUploads) fs.rmSync(uploads, { recursive: true, force: true });
    }
  });

  it('returns 404 for a dotfile name', async () => {
    expect(await rawGet('/api/v1/counselors/assets/avatars/.env')).toBe(404);
  });

  it('keeps serving after a bad request', async () => {
    await rawGet('/api/v1/counselors/assets/avatars/%2e%2e');
    expect(await rawGet('/api/v1/counselors/assets/avatars/does-not-exist.png')).toBe(404);
  });
});

describe('trust proxy', () => {
  // Tiny server using the real app's trust-proxy setting; echoes req.ip and getClientIp.
  let echo: http.Server;
  let echoPort: number;

  beforeAll(async () => {
    const probe = express();
    probe.set('trust proxy', app.get('trust proxy'));
    probe.get('/ip', (req, res) => {
      res.json({ ip: req.ip, clientIp: getClientIp(req) });
    });
    echo = http.createServer(probe);
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    echoPort = (echo.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => echo.close(resolve));
  });

  function ipFor(xff?: string): Promise<{ ip: string; clientIp: string }> {
    return new Promise((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: echoPort, path: '/ip', headers: xff ? { 'X-Forwarded-For': xff } : {} },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(JSON.parse(data)));
          }
        )
        .on('error', reject);
    });
  }

  it('resolves the real client behind nginx (loopback) and the ALB (private IP)', async () => {
    // nginx appends the ALB's private IP; the ALB appended the client's public IP.
    expect((await ipFor('203.0.113.9, 10.0.1.5')).ip).toBe('203.0.113.9');
  });

  it('works without an ALB (client, then nginx only)', async () => {
    expect((await ipFor('203.0.113.9')).ip).toBe('203.0.113.9');
  });

  it('ignores a spoofed leftmost X-Forwarded-For entry', async () => {
    const r = await ipFor('6.6.6.6, 203.0.113.9, 10.0.1.5');
    expect(r.ip).toBe('203.0.113.9');
    // waitlist bot protection must use the same trusted value, not the leftmost entry
    expect(r.clientIp).toBe('203.0.113.9');
  });

  it('does not trust a public address as a proxy', async () => {
    expect((await ipFor('6.6.6.6, 198.51.100.7')).ip).toBe('198.51.100.7');
  });
});
