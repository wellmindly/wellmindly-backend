import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';
import { signToken } from '../lib/jwt';

describe('Quizzes and Health API Routes', () => {
  describe('GET /health', () => {
    it('should return 200 and healthy status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /api/admin/quizzes', () => {
    it('should block unauthorized admin requests', async () => {
      const res = await request(app).get('/api/admin/quizzes');
      expect(res.status).toBe(401); // Unauthorized without JWT
    });
  });

  describe('POST /api/quizzes/submit', () => {
    it('should block unauthorized quiz submissions', async () => {
      const res = await request(app)
        .post('/api/quizzes/submit')
        .send({ answers: {} });
      expect(res.status).toBe(401); // Requires JWT authentication header
    });
  });

  describe('POST /api/quizzes/submit (Authenticated Sanity Test)', () => {
    it('check-ins return band-safe feedback: no AI headline, at most one AI line', async () => {
      const student = await prisma.user.findFirst({
        where: { role: 'STUDENT' }
      });
      expect(student).not.toBeNull();
      if (!student) return;

      const token = signToken({
        sub: student.id,
        email: student.email,
        role: student.role,
        universityId: student.universityId,
      });

      // The app shows fixed copy per score band for check-ins
      // (frontend-student/src/lib/checkinCopy.ts). Gemini may add one
      // observation, written knowing the band, and nothing else. This holds
      // with or without a live GEMINI_API_KEY.
      const res = await request(app)
        .post('/api/quizzes/submit')
        .set('Authorization', `Bearer ${token}`)
        .send({
          quizTitle: 'Emotional check-in',
          quizCategory: 'Wellbeing',
          overallScore: 12,
          maxScore: 30,
          classification: 'A heavy stretch',
          answers: { scores: { 'Good spirits': 50, Calm: 25, Energy: 25, Rested: 25, Engaged: 25, Connection: 0 } }
        });

      expect(res.status).toBe(201);
      expect(res.body.classification).toBe('A heavy stretch');
      expect(res.body.aiFeedback).not.toBeNull();
      expect(res.body.aiFeedback.bandSafe).toBe(true);
      expect(res.body.aiFeedback.headline).toBe('');
      expect(res.body.aiFeedback.narrative).toBe('');
      expect(res.body.aiFeedback.insights).toBeInstanceOf(Array);
      expect(res.body.aiFeedback.insights.length).toBeLessThanOrEqual(1);
    }, 30000);
  });
});
