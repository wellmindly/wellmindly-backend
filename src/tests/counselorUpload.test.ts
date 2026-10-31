import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { signToken } from '../lib/jwt';
import prisma from '../lib/prisma';
import crypto from 'crypto';

describe('Counselor Profile Picture Upload & Serving End-to-End', () => {
  const counselorUser = {
    id: 'counselor-user-test-1',
    email: 'counselor.upload.test@wellmindly.com',
    role: 'COUNSELOR',
  };

  const adminUser = {
    id: 'admin-user-test-1',
    email: 'admin.test@wellmindly.com',
    role: 'ADMIN',
  };

  const studentUser = {
    id: 'student-user-test-1',
    email: 'student.test@wellmindly.com',
    role: 'STUDENT',
  };

  const counselorToken = signToken({
    sub: counselorUser.id,
    email: counselorUser.email,
    role: counselorUser.role,
    universityId: null,
  });

  const adminToken = signToken({
    sub: adminUser.id,
    email: adminUser.email,
    role: adminUser.role,
    universityId: null,
  });

  const studentToken = signToken({
    sub: studentUser.id,
    email: studentUser.email,
    role: studentUser.role,
    universityId: null,
  });

  it('can upload a counselor avatar and serve it back with Cross-Origin headers', async () => {
    const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const uploadRes = await request(app)
      .post('/api/v1/counselors/me/upload')
      .set('Authorization', `Bearer ${counselorToken}`)
      .send({
        fileName: 'test-avatar.png',
        mimeType: 'image/png',
        base64Data: `data:image/png;base64,${samplePngBase64}`,
        folder: 'avatars',
      });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.success).toBe(true);
    expect(uploadRes.body.data.url).toBeDefined();

    const avatarUrl = uploadRes.body.data.url;
    expect(avatarUrl).toContain('/api/v1/counselors/assets/avatars/');

    // Fetch the asset using GET
    const assetRes = await request(app).get(avatarUrl);
    expect(assetRes.status).toBe(200);
    expect(assetRes.headers['content-type']).toContain('image/png');
    // Ensure Cross-Origin embedding is permitted for frontends
    expect(assetRes.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(assetRes.headers['access-control-allow-origin']).toBe('*');
  });

  it('allows invited counselors to upload avatar during setup and saves it', async () => {
    // 1. Create invitation
    const token = crypto.randomBytes(24).toString('hex');
    const email = `test.setup.${Date.now()}@example.com`;
    await prisma.counselorInvitation.create({
      data: {
        token,
        email,
        firstName: 'SetupTest',
        lastName: 'Counselor',
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });

    // 2. Upload avatar with invitation token
    const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const uploadRes = await request(app)
      .post('/api/v1/counselors/setup-upload')
      .send({
        token,
        fileName: 'setup-photo.png',
        mimeType: 'image/png',
        base64Data: `data:image/png;base64,${samplePngBase64}`,
      });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.success).toBe(true);
    const uploadedAvatarUrl = uploadRes.body.data.url;
    expect(uploadedAvatarUrl).toContain('/api/v1/counselors/assets/avatars/');

    // 3. Complete profile setup with the uploaded avatar
    const setupRes = await request(app)
      .post('/api/v1/counselors/setup-profile')
      .send({
        token,
        password: 'Password123!',
        credentials: 'Ph.D. Clinical Psychology',
        specializations: ['Stress', 'Anxiety'],
        bio: 'Compassionate counselor bio',
        phone: '+1 555-0199',
        timezone: 'UTC',
        avatarUrl: uploadedAvatarUrl,
      });

    expect(setupRes.status).toBe(201);
    expect(setupRes.body.success).toBe(true);

    // 4. Verify profile in DB has the avatarUrl
    const createdUser = await prisma.user.findUnique({
      where: { email },
      include: { counselorProfile: true },
    });
    expect(createdUser).toBeDefined();
    expect(createdUser?.counselorProfile?.avatarUrl).toBe(uploadedAvatarUrl);

    // Clean up
    await prisma.counselorProfile.deleteMany({ where: { userId: createdUser!.id } });
    await prisma.user.delete({ where: { id: createdUser!.id } });
  });

  it('normalizes avatar URLs in student, public contacts, and admin counselor directories', async () => {
    // 1. Student counselors endpoint
    const studentRes = await request(app)
      .get('/api/v1/students/counselors')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(studentRes.status).toBe(200);
    expect(studentRes.body.success).toBe(true);
    for (const counselor of studentRes.body.data) {
      if (counselor.avatarUrl) {
        // Must not contain direct s3 aws host
        expect(counselor.avatarUrl).not.toContain('.amazonaws.com/');
      }
    }

    // 2. Public contacts coaches endpoint
    const coachesRes = await request(app).get('/api/contacts/coaches');
    expect(coachesRes.status).toBe(200);
    expect(coachesRes.body.success).toBe(true);
    for (const coach of coachesRes.body.coaches) {
      if (coach.avatarUrl) {
        expect(coach.avatarUrl).not.toContain('.amazonaws.com/');
      }
    }

    // 3. Admin counselors endpoint
    const adminRes = await request(app)
      .get('/api/v1/admin/counselors')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.success).toBe(true);
    for (const c of adminRes.body.data) {
      if (c.avatarUrl) {
        expect(c.avatarUrl).not.toContain('.amazonaws.com/');
      }
    }
  });
});
