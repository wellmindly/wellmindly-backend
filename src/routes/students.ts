import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticateJWT, authorizeRoles } from '../utils/jwt';
import { parseStoredClassification } from '../utils/ai';
const router = Router();

/**
 * GET /api/students/me/daily-checkin
 *
 * Fetches the current daily check-in (mood rating) for the logged-in student.
 */
router.get(
  '/me/daily-checkin',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const email = req.user?.email;
      if (!email) {
        res.status(401).json({ error: 'Email missing from token' });
        return;
      }
      
      const user = await prisma.user.findUnique({
        where: { email },
        include: {
          dailyCheckins: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });

      let rating = null;
      if (user && user.dailyCheckins.length > 0) {
        const latestCheckin = user.dailyCheckins[0];
        const today = new Date().toDateString();
        const checkinDate = new Date(latestCheckin.createdAt).toDateString();
        if (today === checkinDate) {
          rating = latestCheckin.rating;
        }
      }

      res.status(200).json({ checkin: rating });
    } catch (error) {
      console.error('Error fetching daily check-in:', error);
      res.status(500).json({ error: 'Failed to fetch daily check-in' });
    }
  }
);

/**
 * GET /api/students/me/daily-checkins
 *
 * Fetches historical daily check-ins (mood ratings) for the logged-in student.
 */
router.get(
  '/me/daily-checkins',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const email = req.user?.email;
      if (!email) {
        res.status(401).json({ error: 'Email missing from token' });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { email },
        include: {
          dailyCheckins: {
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.status(200).json({ checkins: user.dailyCheckins });
    } catch (error) {
      console.error('Error fetching historical check-ins:', error);
      res.status(500).json({ error: 'Failed to fetch historical check-ins' });
    }
  }
);


/**
 * POST /api/students/me/daily-checkin
 *
 * Saves/updates the current daily check-in (mood rating) for the logged-in student.
 */
router.post(
  '/me/daily-checkin',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const email = req.user?.email;
      if (!email) {
        res.status(401).json({ error: 'Email missing from token' });
        return;
      }

      const { rating } = req.body as { rating?: number };
      // DailyCheckin.rating is an Int; a string used to reach Prisma and 500.
      if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const existingCheckin = await prisma.dailyCheckin.findFirst({
        where: {
          userId: user.id,
          createdAt: {
            gte: todayStart,
          },
        },
      });

      if (existingCheckin) {
        await prisma.dailyCheckin.update({
          where: { id: existingCheckin.id },
          data: { rating },
        });
      } else {
        await prisma.dailyCheckin.create({
          data: {
            userId: user.id,
            rating,
          },
        });
      }

      res.status(200).json({ message: 'Daily check-in saved', rating });
    } catch (error) {
      console.error('Error saving daily check-in:', error);
      res.status(500).json({ error: 'Failed to save daily check-in' });
    }
  }
);

/**
 * GET /api/students/me/results
 *
 * Protected by authentication token checks.
 * Extracts current user credentials from req.user,
 * performs database operations to fetch historic quiz result records via Prisma,
 * and structures response payloads to easily feed client graphing engines.
 */
router.get(
  '/me/results',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User ID missing from token' });
        return;
      }

      // Fetch all historic quiz result records for the authenticated user
      const results = await prisma.quizResult.findMany({
        where: { userId },
        include: {
          quiz: {
            select: {
              id: true,
              title: true,
              category: true,
              maxScore: true,
            },
          },
        },
        orderBy: { completedAt: 'asc' },
      });

      // --- Structure response payloads for client graphing engines ---

      // 1. Timeline series: ordered data points for line/area charts
      const timeline = results.map((r) => {
        const parsed = parseStoredClassification(r.classification);
        return {
          id: r.id,
          date: r.completedAt.toISOString(),
          score: r.overallScore,
          maxScore: r.quiz.maxScore,
          percentage: r.quiz.maxScore > 0
            ? Math.round((r.overallScore / r.quiz.maxScore) * 100)
            : 0,
          classification: parsed.classification,
          aiFeedback: parsed.aiFeedback || null,
          answers: parsed.answers || null,
          quizTitle: r.quiz.title,
          quizCategory: r.quiz.category,
        };
      });

      // 2. Classification distribution: counts per severity bucket for pie/donut charts
      const classificationCounts: Record<string, number> = {};
      for (const r of results) {
        const parsed = parseStoredClassification(r.classification);
        classificationCounts[parsed.classification] = (classificationCounts[parsed.classification] || 0) + 1;
      }
      const distribution = Object.entries(classificationCounts).map(([label, count]) => ({
        label,
        count,
      }));

      // 3. Summary statistics for KPI cards
      const totalAttempts = results.length;

      // Filter for baseline screening / clinical wellness assessments
      const screeningResults = results.filter((r) => {
        const title = r.quiz.title.toLowerCase();
        const category = r.quiz.category.toLowerCase();
        return (
          title.includes('phq-9') ||
          title.includes('check-in') ||
          category.includes('depression') ||
          category.includes('clinical') ||
          category.includes('self-check') ||
          category.includes('wellbeing')
        );
      });

      const latestResult = screeningResults.length > 0 ? screeningResults[screeningResults.length - 1] : null;
      const latestResultParsed = latestResult ? parseStoredClassification(latestResult.classification) : null;
      const averageScore = totalAttempts > 0
        ? Math.round(results.reduce((sum, r) => sum + r.overallScore, 0) / totalAttempts)
        : 0;

      // 4. Per-quiz breakdown: grouped scores for bar/radar charts
      const quizMap: Record<string, { title: string; category: string; maxScore: number; scores: number[]; dates: string[] }> = {};
      for (const r of results) {
        if (!quizMap[r.quizId]) {
          quizMap[r.quizId] = {
            title: r.quiz.title,
            category: r.quiz.category,
            maxScore: r.quiz.maxScore,
            scores: [],
            dates: [],
          };
        }
        quizMap[r.quizId].scores.push(r.overallScore);
        quizMap[r.quizId].dates.push(r.completedAt.toISOString());
      }
      const quizBreakdown = Object.entries(quizMap).map(([quizId, data]) => ({
        quizId,
        title: data.title,
        category: data.category,
        maxScore: data.maxScore,
        attempts: data.scores.length,
        averageScore: Math.round(data.scores.reduce((s, v) => s + v, 0) / data.scores.length),
        scores: data.scores,
        dates: data.dates,
      }));

      res.status(200).json({
        userId,
        totalAttempts,
        averageScore,
        latestResult: latestResult
          ? {
              score: latestResult.overallScore,
              maxScore: latestResult.quiz.maxScore,
              classification: latestResultParsed?.classification || 'Completed',
              aiFeedback: latestResultParsed?.aiFeedback || null,
              answers: latestResultParsed?.answers || null,
              date: latestResult.completedAt.toISOString(),
              quizTitle: latestResult.quiz.title,
            }
          : null,
        timeline,
        distribution,
        quizBreakdown,
      });
    } catch (error) {
      console.error('Error fetching student results:', error);
      res.status(500).json({ error: 'Failed to fetch student results' });
    }
  }
);

/**
 * GET /api/students/hotlines
 *
 * Returns the full crisis hotline corpus, ordered by category then name.
 *
 * Deliberately PUBLIC - no `authenticateJWT`. `/crisis` is an unauthenticated
 * route (frontend-student/src/App.tsx), and a student in crisis may not be
 * logged in or may not have an account at all. Adding an auth guard here would
 * 401 the people this endpoint exists for. It is still rate-limited by the
 * `generalLimiter` mounted on `/api` in app.ts.
 *
 * The docstring here previously read "Protected by JWT authentication." That
 * was false and is the kind of claim that invites someone to "fix" the code to
 * match it. If this ever needs an auth guard, that is a product decision with
 * a crisis-page fallback, not a consistency cleanup.
 */
router.get(
  '/hotlines',
  async (_req: Request, res: Response) => {
    try {
      const hotlines = await prisma.crisisHotline.findMany({
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      });

      res.status(200).json({ hotlines });
    } catch (error) {
      console.error('Error fetching crisis hotlines:', error);
      res.status(500).json({ error: 'Failed to fetch crisis hotlines' });
    }
  }
);

export default router;
