import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticateJWT, authorizeRoles } from '../utils/jwt';
import { parseStoredClassification } from '../utils/ai';
import { TalkStatus } from '../generated/prisma/enums';
import { uploadToS3 } from '../utils/s3';
import {
  getAllowedDomains,
  getBypassEmails,
  addAllowedDomain,
  deleteAllowedDomain,
  addBypassEmail,
  deleteBypassEmail,
  isStudentEligible,
} from '../services/accessControl';

const router = Router();

/**
 * POST /api/admin/upload
 * Upload an image file to AWS S3 bucket wellmindly-assets (us-east-1)
 */
router.post(
  '/upload',
  authenticateJWT,
  authorizeRoles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { fileName, mimeType, base64Data, folder } = req.body || {};

      if (!base64Data) {
        res.status(400).json({ error: 'base64Data is required' });
        return;
      }

      const cleanBase64 = base64Data.includes('base64,')
        ? base64Data.split('base64,')[1]
        : base64Data;

      const buffer = Buffer.from(cleanBase64, 'base64');
      const name = fileName || `avatar_${Date.now()}.png`;
      const type = mimeType || 'image/png';

      const result = await uploadToS3(buffer, name, type, folder || 'avatars');

      res.status(200).json({
        success: true,
        message: 'File uploaded to AWS S3 successfully',
        url: result.url,
        key: result.key,
      });
    } catch (error) {
      console.error('Error uploading file to S3:', error);
      res.status(500).json({ error: 'Failed to upload file to S3' });
    }
  }
);

/**
 * GET /api/admin/metrics
 *
 * Protected by administrative security middleware.
 * Returns structured response data summarizing all rows in the QuizResult collection
 * to output cross-sectional system metrics (total submissions grouped by active classifications).
 */
router.get(
  '/metrics',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      // 1. Total submission count across the entire system
      const totalSubmissions = await prisma.quizResult.count();

      // Fetch all quiz results for in-memory grouping
      const allResultsForMetrics = await prisma.quizResult.findMany({
        select: {
          overallScore: true,
          classification: true,
          quizId: true,
          completedAt: true,
        }
      });

      // 2. Group by classification in-memory after parsing JSON structures
      const classificationMap: Record<string, { count: number; sumScore: number; maxScore: number; minScore: number }> = {};
      
      allResultsForMetrics.forEach(r => {
        const parsed = parseStoredClassification(r.classification);
        const name = parsed.classification || 'Completed';
        
        if (!classificationMap[name]) {
          classificationMap[name] = { count: 0, sumScore: 0, maxScore: r.overallScore, minScore: r.overallScore };
        }
        
        const group = classificationMap[name];
        group.count++;
        group.sumScore += r.overallScore;
        if (r.overallScore > group.maxScore) group.maxScore = r.overallScore;
        if (r.overallScore < group.minScore) group.minScore = r.overallScore;
      });

      const classificationMetrics = Object.entries(classificationMap).map(([name, data]) => ({
        classification: name,
        count: data.count,
        averageScore: Math.round(data.sumScore / data.count),
        maxScore: data.maxScore,
        minScore: data.minScore
      }));

      // 3. Group by quiz: submissions per assessment type
      const quizGroups = await prisma.quizResult.groupBy({
        by: ['quizId'],
        _count: { id: true },
        _avg: { overallScore: true },
      });

      // Fetch quiz titles for display
      const quizIds = quizGroups.map((g) => g.quizId);
      const quizzes = await prisma.quiz.findMany({
        where: { id: { in: quizIds } },
        select: { id: true, title: true, category: true, maxScore: true },
      });
      const quizLookup: Record<string, { title: string; category: string; maxScore: number }> = {};
      for (const q of quizzes) {
        quizLookup[q.id] = { title: q.title, category: q.category, maxScore: q.maxScore };
      }

      const quizMetrics = quizGroups.map((g) => ({
        quizId: g.quizId,
        title: quizLookup[g.quizId]?.title ?? 'Unknown',
        category: quizLookup[g.quizId]?.category ?? 'Unknown',
        maxScore: quizLookup[g.quizId]?.maxScore ?? 0,
        totalSubmissions: g._count.id,
        averageScore: g._avg.overallScore !== null ? Math.round(g._avg.overallScore) : 0,
      }));

      // 4. Submission volume over time: daily counts for trend charts
      const dailyVolume: Record<string, number> = {};
      for (const r of allResultsForMetrics) {
        const dayKey = r.completedAt.toISOString().slice(0, 10); // YYYY-MM-DD
        dailyVolume[dayKey] = (dailyVolume[dayKey] || 0) + 1;
      }
      const submissionTrend = Object.entries(dailyVolume).map(([date, count]) => ({
        date,
        count,
      })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // 5. Total unique users who have submitted at least one quiz
      const uniqueUsers = await prisma.quizResult.groupBy({
        by: ['userId'],
      });

      // 6. Daily check-in mood, for the "Avg Daily Mood" tile on the admin overview.
      // The tile previously hardcoded a value because nothing here exposed one.
      // _avg is null when there are no rows, so the client must handle null.
      const mood = await prisma.dailyCheckin.aggregate({
        _avg: { rating: true },
        _count: { id: true },
      });

      res.status(200).json({
        totalSubmissions,
        totalUniqueUsers: uniqueUsers.length,
        classificationMetrics,
        quizMetrics,
        submissionTrend,
        avgDailyMood: mood._avg.rating,
        totalCheckins: mood._count.id,
      });
    } catch (error) {
      console.error('Error fetching admin metrics:', error);
      res.status(500).json({ error: 'Failed to fetch admin metrics' });
    }
  }
);

/**
 * GET /api/admin/students
 * Retrieves all students.
 */
router.get(
  '/students',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      const students = await prisma.user.findMany({
        // The v1 analytics endpoint counts students with `deletedAt: null`, so
        // without the same filter here the admin list is longer than the
        // headline figure sitting above it.
        where: { role: 'STUDENT', deletedAt: null },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          createdAt: true,
          university: {
            select: {
              name: true,
              domain: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.status(200).json({ students });
    } catch (error) {
      console.error('Error fetching students:', error);
      res.status(500).json({ error: 'Failed to fetch students' });
    }
  }
);

/**
 * GET /api/admin/students/:id
 * Retrieves detailed student profile: checkins, chat messages, quiz results.
 */
router.get(
  '/students/:id',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const studentId = req.params.id as string;
      const student = await prisma.user.findFirst({
        where: { id: studentId, role: 'STUDENT', deletedAt: null },
        include: {
          university: {
            select: {
              name: true,
              domain: true,
              verified: true,
            },
          },
          dailyCheckins: {
            orderBy: { createdAt: 'desc' },
          },
          chatMessages: {
            orderBy: { createdAt: 'asc' },
          },
          quizResults: {
            include: {
              quiz: {
                select: {
                  title: true,
                  category: true,
                  maxScore: true,
                },
              },
              feedback: true,
            },
            orderBy: { completedAt: 'desc' },
          },
        },
      });

      if (!student) {
        res.status(404).json({ error: 'Student not found' });
        return;
      }

      res.status(200).json({ student });
    } catch (error) {
      console.error('Error fetching student details:', error);
      res.status(500).json({ error: 'Failed to fetch student details' });
    }
  }
);

/**
 * GET /api/admin/quizzes
 * Retrieves all quizzes with questions and options.
 */
router.get(
  '/quizzes',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      const quizzes = await prisma.quiz.findMany({
        include: {
          questions: {
            include: {
              options: true,
            },
            orderBy: { index: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      res.status(200).json({ quizzes });
    } catch (error) {
      console.error('Error fetching quizzes:', error);
      res.status(500).json({ error: 'Failed to fetch quizzes' });
    }
  }
);

/**
 * GET /api/admin/feedbacks
 * Retrieves all submitted quiz feedbacks.
 */
router.get(
  '/feedbacks',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      const feedbacks = await prisma.quizFeedback.findMany({
        include: {
          result: {
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                },
              },
              quiz: {
                select: {
                  title: true,
                  category: true,
                  maxScore: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.status(200).json({ feedbacks });
    } catch (error) {
      console.error('Error fetching feedbacks:', error);
      res.status(500).json({ error: 'Failed to fetch feedbacks' });
    }
  }
);

/**
 * GET /api/admin/quiz-results
 * Retrieves all quiz results in the system, optionally filtered by quizId.
 */
router.get(
  '/quiz-results',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const quizId = req.query.quizId as string | undefined;
      const where = quizId ? { quizId } : {};

      const quizResults = await prisma.quizResult.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
          quiz: {
            select: {
              title: true,
              category: true,
              maxScore: true,
            },
          },
        },
        orderBy: { completedAt: 'desc' },
      });

      res.status(200).json({ quizResults });
    } catch (error) {
      console.error('Error fetching quiz results:', error);
      res.status(500).json({ error: 'Failed to fetch quiz results' });
    }
  }
);

/**
 * GET /api/admin/quiz-results/:id
 * Retrieves detailed quiz submission with quiz questions and user info.
 */
router.get(
  '/quiz-results/:id',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const quizResult = await prisma.quizResult.findUnique({
        where: { id },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
          quiz: {
            include: {
              questions: {
                include: {
                  options: true,
                },
                orderBy: { index: 'asc' },
              },
            },
          },
          feedback: true,
        },
      });

      if (!quizResult) {
        return res.status(404).json({ error: 'Quiz result not found' });
      }

      res.status(200).json({ quizResult });
    } catch (error) {
      console.error('Error fetching quiz result details:', error);
      res.status(500).json({ error: 'Failed to fetch quiz result details' });
    }
  }
);

/**
 * GET /api/admin/talk/metrics
 * Calculate AI tokens cost and moderation metrics.
 */
router.get(
  '/talk/metrics',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      const notesTokens = await prisma.talkNote.aggregate({
        _sum: { inputTokens: true, outputTokens: true }
      });
      const repliesTokens = await prisma.talkReply.aggregate({
        _sum: { inputTokens: true, outputTokens: true }
      });

      const totalInput = (notesTokens._sum.inputTokens || 0) + (repliesTokens._sum.inputTokens || 0);
      const totalOutput = (notesTokens._sum.outputTokens || 0) + (repliesTokens._sum.outputTokens || 0);

      // Gemini 2.5 Flash pricing: $0.075 / 1M input, $0.30 / 1M output
      const inputCost = (totalInput / 1000000) * 0.075;
      const outputCost = (totalOutput / 1000000) * 0.30;
      const totalCostUsd = Number((inputCost + outputCost).toFixed(5));

      const totalNotes = await prisma.talkNote.count();
      const totalReplies = await prisma.talkReply.count();
      const flaggedNotes = await prisma.talkNote.count({
        where: { status: { in: [TalkStatus.FLAGGED, TalkStatus.REJECTED] } }
      });
      const flaggedReplies = await prisma.talkReply.count({
        where: { status: { in: [TalkStatus.FLAGGED, TalkStatus.REJECTED] } }
      });
      const totalRooms = await prisma.talkRoom.count();

      res.status(200).json({
        totalCostUsd,
        totalInput,
        totalOutput,
        totalNotes,
        totalReplies,
        flaggedNotes,
        flaggedReplies,
        totalRooms
      });
    } catch (error) {
      console.error('Error fetching talk metrics:', error);
      res.status(500).json({ error: 'Failed to fetch talk metrics' });
    }
  }
);

/**
 * GET /api/admin/talk/rooms
 * List all talk rooms.
 */
router.get(
  '/talk/rooms',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      const rooms = await prisma.talkRoom.findMany({
        include: {
          _count: { select: { notes: true } }
        },
        orderBy: { createdAt: 'desc' }
      });
      res.status(200).json({ rooms });
    } catch (error) {
      console.error('Error fetching talk rooms:', error);
      res.status(500).json({ error: 'Failed to fetch talk rooms' });
    }
  }
);

/**
 * POST /api/admin/talk/rooms
 * Create a new talk room.
 */
router.post(
  '/talk/rooms',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { name, description } = (req.body || {}) as { name: string; description?: string };
      if (!name || name.trim().length === 0) {
        res.status(400).json({ error: 'Room name is required' });
        return;
      }

      const room = await prisma.talkRoom.create({
        data: {
          name: name.trim(),
          description: description?.trim()
        }
      });
      res.status(201).json({ room });
    } catch (error) {
      console.error('Error creating talk room:', error);
      res.status(500).json({ error: 'Failed to create talk room' });
    }
  }
);

/**
 * PUT /api/admin/talk/rooms/:roomId
 * Toggle isActive state.
 */
router.put(
  '/talk/rooms/:roomId',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { isActive } = (req.body || {}) as { isActive: boolean };
      const room = await prisma.talkRoom.update({
        where: { id: req.params.roomId as string },
        data: { isActive: !!isActive }
      });
      res.status(200).json({ room });
    } catch (error) {
      console.error('Error updating talk room:', error);
      res.status(500).json({ error: 'Failed to update talk room' });
    }
  }
);

/**
 * DELETE /api/admin/talk/rooms/:roomId
 * Delete a talk room.
 */
router.delete(
  '/talk/rooms/:roomId',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      await prisma.talkRoom.delete({
        where: { id: req.params.roomId as string }
      });
      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error deleting talk room:', error);
      res.status(500).json({ error: 'Failed to delete talk room' });
    }
  }
);

/**
 * GET /api/admin/talk/flagged
 * Retrieve flagged notes and replies.
 */
router.get(
  '/talk/flagged',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      const flaggedNotes = await prisma.talkNote.findMany({
        where: { status: { in: [TalkStatus.FLAGGED, TalkStatus.REJECTED] } },
        include: { room: true },
        orderBy: { createdAt: 'desc' }
      });

      const flaggedReplies = await prisma.talkReply.findMany({
        where: { status: { in: [TalkStatus.FLAGGED, TalkStatus.REJECTED] } },
        include: { note: { include: { room: true } } },
        orderBy: { createdAt: 'desc' }
      });

      res.status(200).json({ flaggedNotes, flaggedReplies });
    } catch (error) {
      console.error('Error fetching flagged content:', error);
      res.status(500).json({ error: 'Failed to fetch flagged content' });
    }
  }
);

/**
 * POST /api/admin/talk/flagged/:type/:id/resolve
 * Resolve action for flagged content.
 */
router.post(
  '/talk/flagged/:type/:id/resolve',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { type, id } = req.params as { type: 'note' | 'reply'; id: string };
      const { action } = (req.body || {}) as { action: 'APPROVE' | 'REJECT' | 'DELETE' };

      if (!['APPROVE', 'REJECT', 'DELETE'].includes(action)) {
        res.status(400).json({ error: 'Invalid resolution action' });
        return;
      }

      if (type === 'note') {
        if (action === 'APPROVE') {
          await prisma.talkNote.update({
            where: { id },
            data: { status: TalkStatus.APPROVED, moderationReason: null }
          });
        } else if (action === 'REJECT') {
          await prisma.talkNote.update({
            where: { id },
            data: { status: TalkStatus.REJECTED }
          });
        } else if (action === 'DELETE') {
          await prisma.talkNote.delete({ where: { id } });
        }
      } else if (type === 'reply') {
        if (action === 'APPROVE') {
          await prisma.talkReply.update({
            where: { id },
            data: { status: TalkStatus.APPROVED, moderationReason: null }
          });
        } else if (action === 'REJECT') {
          await prisma.talkReply.update({
            where: { id },
            data: { status: TalkStatus.REJECTED }
          });
        } else if (action === 'DELETE') {
          await prisma.talkReply.delete({ where: { id } });
        }
      } else {
        res.status(400).json({ error: 'Invalid content type' });
        return;
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error resolving flagged content:', error);
      res.status(500).json({ error: 'Failed to resolve flagged content' });
    }
  }
);

/**
 * =========================================================================
 * Access Control Management: Allowed University Domains & Bypass Emails
 * =========================================================================
 */

/**
 * GET /api/admin/access-control
 * Fetches all allowed domains and bypass emails.
 */
router.get(
  '/access-control',
  authenticateJWT,
  authorizeRoles('ADMIN', 'SUPER_ADMIN'),
  async (_req: Request, res: Response) => {
    try {
      const [domains, bypassEmails] = await Promise.all([
        getAllowedDomains(),
        getBypassEmails(),
      ]);
      res.status(200).json({
        success: true,
        domains,
        bypassEmails,
      });
    } catch (error) {
      console.error('Error fetching access control data:', error);
      res.status(500).json({ error: 'Failed to fetch access control data' });
    }
  }
);

/**
 * POST /api/admin/access-control/domains
 * Adds a new allowed university domain (e.g. ves.ac.in).
 */
router.post(
  '/access-control/domains',
  authenticateJWT,
  authorizeRoles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { domain, name } = req.body || {};
      if (!domain || typeof domain !== 'string') {
        res.status(400).json({ error: 'A valid domain is required' });
        return;
      }
      const item = await addAllowedDomain(domain, name);
      res.status(201).json({
        success: true,
        domain: item,
      });
    } catch (error: any) {
      console.error('Error adding allowed domain:', error);
      res.status(400).json({ error: error?.message || 'Failed to add allowed domain' });
    }
  }
);

/**
 * DELETE /api/admin/access-control/domains/:id
 * Removes an allowed university domain.
 */
router.delete(
  '/access-control/domains/:id',
  authenticateJWT,
  authorizeRoles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const success = await deleteAllowedDomain(id);
      res.status(200).json({ success });
    } catch (error) {
      console.error('Error deleting allowed domain:', error);
      res.status(500).json({ error: 'Failed to delete allowed domain' });
    }
  }
);

/**
 * POST /api/admin/access-control/bypass-emails
 * Adds a new bypass student email (e.g. jmalani54@gmail.com).
 */
router.post(
  '/access-control/bypass-emails',
  authenticateJWT,
  authorizeRoles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { email, note } = req.body || {};
      if (!email || typeof email !== 'string') {
        res.status(400).json({ error: 'A valid email is required' });
        return;
      }
      const item = await addBypassEmail(email, note);
      res.status(201).json({
        success: true,
        bypassEmail: item,
      });
    } catch (error: any) {
      console.error('Error adding bypass email:', error);
      res.status(400).json({ error: error?.message || 'Failed to add bypass email' });
    }
  }
);

/**
 * DELETE /api/admin/access-control/bypass-emails/:id
 * Removes a bypass student email.
 */
router.delete(
  '/access-control/bypass-emails/:id',
  authenticateJWT,
  authorizeRoles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const success = await deleteBypassEmail(id);
      res.status(200).json({ success });
    } catch (error) {
      console.error('Error deleting bypass email:', error);
      res.status(500).json({ error: 'Failed to delete bypass email' });
    }
  }
);


/**
 * POST /api/admin/access-control/check
 * Diagnostic tool for testing if an email has university eligibility.
 */
router.post(
  '/access-control/check',
  authenticateJWT,
  authorizeRoles('ADMIN', 'SUPER_ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const { email } = req.body || {};
      if (!email || typeof email !== 'string') {
        res.status(400).json({ error: 'An email is required to check' });
        return;
      }
      const result = await isStudentEligible(email);
      res.status(200).json(result);
    } catch (error) {
      console.error('Error checking eligibility:', error);
      res.status(500).json({ error: 'Failed to evaluate eligibility' });
    }
  }
);

export default router;

