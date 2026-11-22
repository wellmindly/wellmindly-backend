import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import app from '../app';
import { signToken } from '../lib/jwt';
import prisma from '../lib/prisma';

// A counselor must be in exactly one admin list: "Counselor Applications"
// (/api/contacts/counselor) until they activate, then only the "Counselor
// Directory" (/api/v1/admin/counselors).
describe('Counselor applications vs directory sync', () => {
  const email = `pipeline.${Date.now()}@example.test`;
  const adminToken = signToken({ sub: 'pipeline-admin', email: 'pipeline-admin@example.test', role: 'ADMIN', universityId: null });
  const auth = { Authorization: `Bearer ${adminToken}` };

  const inApplications = async () => {
    const res = await request(app).get('/api/contacts/counselor?page=1&limit=500').set(auth);
    expect(res.status).toBe(200);
    return (res.body.requests as { email: string }[]).filter((r) => r.email === email);
  };
  const inDirectory = async () => {
    const res = await request(app).get('/api/v1/admin/counselors?limit=100').set(auth);
    expect(res.status).toBe(200);
    return (res.body.data as { user: { email: string } }[]).filter((c) => c.user.email === email);
  };

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.counselorInvitation.deleteMany({ where: { email } });
  });

  it('moves an invited counselor from Applications to Directory on activation', async () => {
    const invite = await request(app)
      .post('/api/v1/admin/counselors/invite')
      .set(auth)
      .send({ email: email.toUpperCase(), firstName: 'Pipe', lastName: 'Line' });
    expect(invite.status).toBe(201);
    const invitationId = invite.body.data.invitation.id;

    const pending = await inApplications();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ source: 'invitation', stage: 'INVITE_SENT' });
    expect(await inDirectory()).toHaveLength(0);

    const resend = await request(app).post(`/api/v1/admin/counselors/invitations/${invitationId}/resend`).set(auth);
    expect(resend.status).toBe(200);
    const token = new URL(resend.body.data.setupUrl).searchParams.get('token');

    const setup = await request(app)
      .post('/api/v1/counselors/setup-profile')
      .send({ token, password: 'PipelinePass123!', credentials: 'M.A. Psychology' });
    expect(setup.status).toBe(201);

    expect(await inApplications()).toHaveLength(0);
    expect(await inDirectory()).toHaveLength(1);

    // Re-inviting or resending to an activated counselor is refused, not a duplicate.
    const again = await request(app)
      .post('/api/v1/admin/counselors/invite')
      .set(auth)
      .send({ email, firstName: 'Pipe', lastName: 'Line' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_ACTIVATED');
    expect(await inApplications()).toHaveLength(0);
  });

  it('hides a stale open invitation once the account exists', async () => {
    await prisma.counselorInvitation.update({ where: { email }, data: { used: false } });
    expect(await inApplications()).toHaveLength(0);
  });

  it('returns 404 JSON for unknown invitations', async () => {
    const res = await request(app).delete('/api/v1/admin/counselors/invitations/does-not-exist').set(auth);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('S3 upload gating', () => {
  it('uses S3 in production even without static keys (EB instance role)', async () => {
    const { isS3Enabled } = await import('../utils/s3');
    const saved = { node: process.env.NODE_ENV, flag: process.env.S3_UPLOADS };
    try {
      delete process.env.S3_UPLOADS;
      process.env.NODE_ENV = 'production';
      expect(isS3Enabled()).toBe(true);
      process.env.S3_UPLOADS = 'false';
      expect(isS3Enabled()).toBe(false);
      process.env.NODE_ENV = 'test';
      process.env.S3_UPLOADS = 'true';
      expect(isS3Enabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = saved.node;
      if (saved.flag === undefined) delete process.env.S3_UPLOADS;
      else process.env.S3_UPLOADS = saved.flag;
    }
  });
});
