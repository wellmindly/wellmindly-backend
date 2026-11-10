import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticateJWT, authorizeRoles } from '../utils/jwt';
import { parseStoredClassification } from '../utils/ai';

// Smallest number of participating students for which per-band and per-quiz
// breakdowns are returned. Below this a university admin could work out an
// individual student's results from the distribution (e.g. one participant
// means the distribution IS that student's result).
const MIN_COHORT_SIZE = 5;

const router = Router();

/**
 * GET /api/university/metrics
 *
 * Protected by specialized university authentication roles.
 * Fetches the host user's University identity profile constraints,
 * joins related student identity parameters anonymously,
 * compiles cluster scoring averages,
 * and restricts row reads to avoid data exposure.
 */
router.get(
  '/metrics',
  authenticateJWT,
  authorizeRoles('UNIVERSITY', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.sub;
      const universityId = req.user?.universityId;

      if (!userId) {
        res.status(401).json({ error: 'User ID missing from token' });
        return;
      }

      if (!universityId) {
        res.status(403).json({ error: 'No university affiliation found on this account' });
        return;
      }

      // Verify the university exists and fetch profile constraints
      const university = await prisma.university.findUnique({
        where: { id: universityId },
        select: { id: true, name: true, domain: true, verified: true },
      });

      if (!university) {
        res.status(404).json({ error: 'University profile not found' });
        return;
      }

      // Fetch all student users affiliated with this university (identity parameters)
      const affiliatedStudentIds = await prisma.user.findMany({
        where: {
          universityId,
          role: 'STUDENT',
        },
        select: { id: true },
      });

      const studentIds = affiliatedStudentIds.map((u) => u.id);
      const totalStudents = studentIds.length;

      if (totalStudents === 0) {
        res.status(200).json({
          university: {
            id: university.id,
            name: university.name,
            domain: university.domain,
          },
          suppressed: true,
          minCohortSize: MIN_COHORT_SIZE,
          totalStudents: 0,
          participatingStudents: 0,
          participationRate: 0,
          totalSubmissions: 0,
          clusterAverage: 0,
          classificationDistribution: [],
          quizMetrics: [],
          submissionTrend: [],
        });
        return;
      }

      // Restrict row reads to only students affiliated with this university
      const results = await prisma.quizResult.findMany({
        where: { userId: { in: studentIds } },
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

      const totalSubmissions = results.length;

      // Compile cluster scoring averages (anonymous: no student identity exposed)
      const clusterAverage = totalSubmissions > 0
        ? Math.round(results.reduce((sum, r) => sum + r.overallScore, 0) / totalSubmissions)
        : 0;

      // Classification distribution across the university cluster
      const classificationCounts: Record<string, number> = {};
      for (const r of results) {
        // QuizResult.classification is a JSON blob holding the band label plus
        // the student's individual answers and AI feedback. Only the band label
        // may leave this route; grouping on the raw string sent each student's
        // answers to the university dashboard as a "label".
        const label = parseStoredClassification(r.classification).classification || 'Completed';
        classificationCounts[label] = (classificationCounts[label] || 0) + 1;
      }
      const classificationDistribution = Object.entries(classificationCounts).map(([label, count]) => ({
        label,
        count,
        percentage: totalSubmissions > 0 ? Math.round((count / totalSubmissions) * 100) : 0,
      }));

      // Per-quiz cluster metrics (anonymous aggregates only)
      const quizMap: Record<string, { title: string; category: string; maxScore: number; scores: number[]; students: Set<string> }> = {};
      for (const r of results) {
        if (!quizMap[r.quizId]) {
          quizMap[r.quizId] = {
            title: r.quiz.title,
            category: r.quiz.category,
            maxScore: r.quiz.maxScore,
            scores: [],
            students: new Set<string>(),
          };
        }
        quizMap[r.quizId].scores.push(r.overallScore);
        quizMap[r.quizId].students.add(r.userId);
      }

      // A quiz taken by fewer than MIN_COHORT_SIZE distinct students is left
      // out entirely, and min/max are never sent: the lowest or highest score
      // in a group is by definition one identifiable student's score.
      const quizMetrics = Object.entries(quizMap)
        .filter(([, data]) => data.students.size >= MIN_COHORT_SIZE)
        .map(([quizId, data]) => ({
        quizId,
        title: data.title,
        category: data.category,
        maxScore: data.maxScore,
        totalSubmissions: data.scores.length,
        averageScore: Math.round(data.scores.reduce((s, v) => s + v, 0) / data.scores.length),
        minScore: null,
        maxObservedScore: null,
      }));

      // Submission volume over time: daily counts for trend visualization
      const dailyVolume: Record<string, number> = {};
      for (const r of results) {
        const dayKey = r.completedAt.toISOString().slice(0, 10);
        dailyVolume[dayKey] = (dailyVolume[dayKey] || 0) + 1;
      }
      const submissionTrend = Object.entries(dailyVolume).map(([date, count]) => ({
        date,
        count,
      }));

      // Participation rate: how many affiliated students have submitted at least one quiz
      const participatingStudentIds = new Set(results.map((r) => r.userId));
      const participationRate = totalStudents > 0
        ? Math.round((participatingStudentIds.size / totalStudents) * 100)
        : 0;

      // Small-cohort suppression: headline counts stay, breakdowns go.
      const suppressed = participatingStudentIds.size < MIN_COHORT_SIZE;

      res.status(200).json({
        university: {
          id: university.id,
          name: university.name,
          domain: university.domain,
        },
        suppressed,
        minCohortSize: MIN_COHORT_SIZE,
        totalStudents,
        participatingStudents: participatingStudentIds.size,
        participationRate,
        totalSubmissions,
        clusterAverage: suppressed ? 0 : clusterAverage,
        classificationDistribution: suppressed ? [] : classificationDistribution,
        quizMetrics: suppressed ? [] : quizMetrics,
        submissionTrend: suppressed ? [] : submissionTrend,
      });
    } catch (error) {
      console.error('Error fetching university metrics:', error);
      res.status(500).json({ error: 'Failed to fetch university metrics' });
    }
  }
);

export default router;
