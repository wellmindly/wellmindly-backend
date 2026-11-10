import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticateJWT, authorizeRoles } from '../utils/jwt';
import { generateQuizFeedback, parseStoredClassification } from '../utils/ai';
import { bandFor, bandForPercent, WELLBEING_MAX_SCORE } from '../lib/wellbeing';

const router = Router();

/**
 * GET /api/quizzes/:id/questions
 *
 * Fetches all questions for a specific quiz ID.
 * Serves a clean JSON schema listing structural metadata fields, 
 * question strings, indexing numbers, and lookup parameters (options) 
 * for rendering on client views.
 */
router.get('/:id/questions', async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    // Verify the quiz exists
    const quiz = await prisma.quiz.findUnique({
      where: { id },
    });

    if (!quiz) {
      res.status(404).json({ error: 'Quiz not found' });
      return;
    }

    // Fetch the questions and joined options, ordered by index
    const questions = await prisma.question.findMany({
      where: { quizId: id },
      include: {
        options: {
          select: {
            id: true,
            label: true,
            points: true,
          },
          orderBy: { points: 'asc' }, // Order options logically by point value
        },
      },
      orderBy: {
        index: 'asc',
      },
    });

    // Format the response into a clean schema structure for client views
    const schema = {
      quizId: quiz.id,
      title: quiz.title,
      category: quiz.category,
      totalQuestions: questions.length,
      questions: questions.map((q) => ({
        id: q.id,
        index: q.index,
        type: q.type,
        text: q.text,
        options: q.options,
      })),
    };

    res.status(200).json(schema);
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: 'Failed to fetch quiz questions' });
  }
});

/**
 * POST /api/quizzes/submit
 *
 * Ingests a payload array container tracking question scores.
 * Protected by user role middleware validation guards.
 * Server-side controller parses cumulative parameters, assigns a
 * non-diagnostic band string from src/lib/wellbeing.ts,
 * stores values to the QuizResult database table using Prisma,
 * and responds with the processed database object.
 */
router.post(
  '/submit',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User ID missing from token' });
        return;
      }

      let quizId = req.body.quizId || req.query.quizId;
      const quizTitle = req.body.quizTitle;

      // Non-string ids/titles used to reach Prisma and come back as a 500.
      if ((quizId !== undefined && typeof quizId !== 'string') || (quizTitle !== undefined && typeof quizTitle !== 'string')) {
        res.status(400).json({ error: 'quizId and quizTitle must be strings' });
        return;
      }
      const quizCategory = req.body.quizCategory || req.body.category;
      const maxScore = req.body.maxScore;

      let quiz = null;

      if (quizId) {
        quiz = await prisma.quiz.findUnique({
          where: { id: quizId },
        });
      }

      if (!quiz && quizTitle) {
        // Find existing quiz by title
        quiz = await prisma.quiz.findFirst({
          where: { title: quizTitle },
        });
        if (!quiz) {
          // Auto-create the quiz record in the database
          quiz = await prisma.quiz.create({
            data: {
              title: quizTitle,
              category: quizCategory || 'General',
              totalQuestions: req.body.totalQuestions || 1,
              maxScore: typeof maxScore === 'number' ? maxScore : 100,
              description: req.body.description || 'Self-reflection interactive test',
            },
          });
        }
        quizId = quiz.id;
      }

      // Fallback: fetch the first Quiz from the database if not found/provided
      if (!quiz && !quizId) {
        const defaultQuiz = await prisma.quiz.findFirst({
          orderBy: { createdAt: 'asc' },
        });
        if (defaultQuiz) {
          quiz = defaultQuiz;
          quizId = defaultQuiz.id;
        } else {
          res.status(404).json({ error: 'No quiz found to associate this submission with' });
          return;
        }
      }

      let overallScore = typeof req.body.overallScore === 'number' && Number.isFinite(req.body.overallScore)
        ? req.body.overallScore
        : null;
      let classification = req.body.classification;

      if (overallScore === null) {
        // Parse from answers / scores payload
        let scoresArray: any[] = [];
        if (Array.isArray(req.body)) {
          scoresArray = req.body;
        } else if (req.body && Array.isArray(req.body.answers)) {
          scoresArray = req.body.answers;
        } else if (req.body && Array.isArray(req.body.scores)) {
          scoresArray = req.body.scores;
        } else if (req.body && typeof req.body.answers === 'object') {
          scoresArray = Object.entries(req.body.answers).map(([key, value]) => ({
            questionId: key,
            score: Number(value),
          }));
        }

        if (scoresArray && scoresArray.length > 0) {
          overallScore = 0;
          for (const item of scoresArray) {
            if (typeof item === 'number') {
              overallScore += item;
            } else if (item && typeof item === 'object') {
              const scoreVal = item.score !== undefined ? item.score : (item.points !== undefined ? item.points : item.value);
              if (typeof scoreVal === 'number') {
                overallScore += scoreVal;
              } else if (typeof scoreVal === 'string') {
                const parsed = parseInt(scoreVal, 10);
                if (!isNaN(parsed)) {
                  overallScore += parsed;
                }
              }
            }
          }
        }
      }

      if (overallScore === null) {
        res.status(400).json({ error: 'Payload must contain overallScore or a non-empty array of question scores/answers' });
        return;
      }

      // Assign a non-diagnostic band string if the client did not send one.
      // See src/lib/wellbeing.ts: this used to emit 'Severe Depression' at a
      // score of 13 out of 15 on a five-question instrument, which is a
      // diagnosis this service cannot make. Cut points are unchanged.
      if (!classification && quiz) {
        const isWellbeingCheckin =
          quiz.title.toLowerCase().includes('phq-9') ||
          quiz.title.toLowerCase().includes('wellbeing check-in') ||
          quiz.category.toLowerCase().includes('clinical') ||
          quiz.category.toLowerCase().includes('self-check');

        if (isWellbeingCheckin && quiz.maxScore === WELLBEING_MAX_SCORE) {
          classification = bandFor(overallScore).label;
        } else {
          const pct = quiz.maxScore > 0 ? (overallScore / quiz.maxScore) * 100 : 0;
          classification = bandForPercent(pct);
        }
      }

      // The old code had an explicit override here that forced
      // 'Severe Depression' whenever a "phq-9" titled quiz scored above 15.
      // It was unreachable for the five-question instrument (its max IS 15) and
      // it was a diagnosis either way, so it is gone rather than rescored.

      let storedClassification = classification || 'Completed';
      let aiFeedbackResult = null;

      // Call Gemini if API key is present
      try {
        const aiFeedback = await generateQuizFeedback(
          quiz?.title || quizTitle || 'Self-reflection Test',
          quizCategory || 'General',
          overallScore,
          quiz?.maxScore || maxScore || 100,
          classification || 'Completed'
        );

        if (aiFeedback) {
          aiFeedbackResult = aiFeedback;
        }
      } catch (aiErr) {
        console.error('Failed to generate AI feedback:', aiErr);
      }

      // Always serialize to JSON string to record detailed answers
      storedClassification = JSON.stringify({
        classification: classification || 'Completed',
        aiFeedback: aiFeedbackResult,
        answers: req.body.answers || req.body.scores || req.body || null,
      });

      // Store values to the QuizResult database table using Prisma
      const quizResult = await prisma.quizResult.create({
        data: {
          userId,
          quizId: quizId!,
          overallScore,
          classification: storedClassification,
        },
        include: {
          quiz: {
            select: {
              title: true,
              category: true,
            },
          },
        },
      });

      const parsed = parseStoredClassification(quizResult.classification);
      res.status(201).json({
        ...quizResult,
        classification: parsed.classification,
        aiFeedback: parsed.aiFeedback || null,
      });
    } catch (error) {
      console.error('Error submitting quiz:', error);
      res.status(500).json({ error: 'Failed to process quiz submission' });
    }
  }
);

/**
 * POST /api/quizzes/:resultId/feedback
 *
 * Submits user rating and comments feedback for a completed quiz result.
 * Protected by JWT authentication.
 */
router.post(
  '/:resultId/feedback',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const resultId = req.params.resultId;
      if (typeof resultId !== 'string') {
        res.status(400).json({ error: 'Invalid result ID' });
        return;
      }
      const { rating, comments } = req.body as { rating?: number; comments?: string };

      if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
        return;
      }

      // Verify the quiz result exists and belongs to the current user
      const userId = req.user?.sub;
      const result = await prisma.quizResult.findFirst({
        where: { id: resultId, userId },
      });

      if (!result) {
        res.status(404).json({ error: 'Quiz result not found or access denied' });
        return;
      }

      // Upsert feedback
      const feedback = await prisma.quizFeedback.upsert({
        where: { resultId },
        update: { rating, comments },
        create: { resultId, rating, comments },
      });

      res.status(201).json({ message: 'Feedback submitted successfully', feedback });
    } catch (error) {
      console.error('Error submitting quiz feedback:', error);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }
);

export default router;

