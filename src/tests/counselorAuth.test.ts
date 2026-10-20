import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import app from '../app';
import { env } from '../config/env';

const mockSendEmail = vi.fn().mockResolvedValue(true);
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../utils/mailer', () => ({
  sendEmail: (opts: any) => mockSendEmail(opts),
  getOtpTemplate: vi.fn().mockReturnValue('<html>OTP</html>'),
  getPasswordResetLinkTemplate: vi.fn().mockReturnValue('<html>RESET LINK</html>'),
}));

vi.mock('../lib/prisma', () => ({
  default: {
    user: {
      findUnique: (args: any) => mockFindUnique(args),
      update: (args: any) => mockUpdate(args),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  },
}));

describe('Counselor Password Reset API Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockCounselor = {
    id: 'counselor-uuid-1',
    email: 'counselor@wellmindly.com',
    firstName: 'Dr. Jane',
    lastName: 'Doe',
    role: 'COUNSELOR',
    passwordHash: '$2b$10$existingHashVal12345678901234567890',
    counselorProfile: {
      id: 'profile-uuid-1',
      status: 'ACTIVE',
    },
  };

  describe('POST /api/v1/counselors/forgot-password', () => {
    it('should return 400 if email is missing', async () => {
      const res = await request(app)
        .post('/api/v1/counselors/forgot-password')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it('should return 404 if user is not found or not a counselor', async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      const res = await request(app)
        .post('/api/v1/counselors/forgot-password')
        .send({ email: 'unknown@wellmindly.com' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('USER_NOT_FOUND');
    });

    it('should send reset email and return success when counselor exists', async () => {
      mockFindUnique.mockResolvedValueOnce(mockCounselor);

      const res = await request(app)
        .post('/api/v1/counselors/forgot-password')
        .send({ email: 'Counselor@Wellmindly.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('Password reset link has been sent');
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'counselor@wellmindly.com',
          subject: expect.stringContaining('Reset Your Counselor Password'),
        })
      );
    });
  });

  describe('POST /api/v1/counselors/verify-reset-token', () => {
    it('should return 400 if token is missing', async () => {
      const res = await request(app)
        .post('/api/v1/counselors/verify-reset-token')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it('should return 400 for an invalid token', async () => {
      mockFindUnique.mockResolvedValueOnce(mockCounselor);

      const res = await request(app)
        .post('/api/v1/counselors/verify-reset-token')
        .send({ token: 'invalid.jwt.token', email: mockCounselor.email });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });

    it('should return valid=true for a legitimate reset token', async () => {
      mockFindUnique.mockResolvedValue(mockCounselor);

      const secret = `${env.JWT_SECRET}-${mockCounselor.passwordHash}`;
      const validToken = jwt.sign(
        {
          sub: mockCounselor.id,
          email: mockCounselor.email,
          role: mockCounselor.role,
          purpose: 'counselor_reset_password',
        },
        secret,
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .post('/api/v1/counselors/verify-reset-token')
        .send({ token: validToken, email: mockCounselor.email });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.email).toBe(mockCounselor.email);
    });
  });

  describe('POST /api/v1/counselors/reset-password', () => {
    it('should return 400 if new password is too short', async () => {
      const res = await request(app)
        .post('/api/v1/counselors/reset-password')
        .send({ token: 'some-token', newPassword: '123' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it('should successfully reset password with valid token and update database', async () => {
      mockFindUnique.mockResolvedValue(mockCounselor);
      mockUpdate.mockResolvedValueOnce({
        ...mockCounselor,
        passwordHash: '$2b$10$newHashedPassword12345',
      });

      const secret = `${env.JWT_SECRET}-${mockCounselor.passwordHash}`;
      const validToken = jwt.sign(
        {
          sub: mockCounselor.id,
          email: mockCounselor.email,
          role: mockCounselor.role,
          purpose: 'counselor_reset_password',
        },
        secret,
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .post('/api/v1/counselors/reset-password')
        .send({
          token: validToken,
          newPassword: 'MyNewSecurePassword!2026',
          email: mockCounselor.email,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toContain('Password has been reset successfully');
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockCounselor.id },
          data: expect.objectContaining({
            passwordHash: expect.any(String),
          }),
        })
      );
    });
  });
});
