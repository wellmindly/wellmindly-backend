import { Router, Request, Response } from 'express';
import { authenticateJWT, authorizeRoles } from '../utils/jwt';
import { getGeminiClient } from '../utils/ai';
import { env } from '../config/env';
import prisma from '../lib/prisma';

const router = Router();

// Helper to determine daily limit based on the model in use to support users within the $1.50 monthly budget
function getMaxRequestsForModel(modelName: string): number {
  const name = modelName.toLowerCase();
  if (name.includes('3.5-flash')) {
    return 300; // 300 requests per student daily (restricts maximum monthly spend to ~$1.44 per student)
  }
  if (name.includes('2.5-flash-lite') || name.includes('lite')) {
    return 600; // 600 requests per student daily (restricts maximum monthly spend to ~$1.44 per student)
  }
  if (name.includes('2.5-flash') || name.includes('flash')) {
    return 300; // 300 requests per student daily (restricts maximum monthly spend to ~$1.44 per student)
  }
  if (name.includes('pro')) {
    return 15; // 15 requests per student daily (restricts maximum monthly spend to ~$1.21 per student)
  }
  if (name.includes('gemma')) {
    return 10;
  }
  return 100; // Default fallback
}

// Helper to calculate total user requests today
async function getDailyRequestsUsed(userId: string): Promise<number> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  return await prisma.chatMessage.count({
    where: {
      userId,
      sender: 'USER',
      createdAt: {
        gte: startOfToday,
      },
      message: {
        startsWith: 'WriteMindly User Message',
      },
    },
  });
}

// System instruction for WriteMindly
const SYSTEM_INSTRUCTION = `You are WriteMindly, an empathetic, calm, and grounded mental wellness bot and supportive companion for a university student.
Speak in the WellMindly brand voice:
- Role & Persona: A compassionate, non-judgmental mental wellness AI bot. You provide a safe, confidential space where students can unpack emotional stress, academic burnout, anxiety, racing thoughts, loneliness, and self-doubt.
- Approach:
  1. Deep Emotional Validation: Listen deeply and acknowledge the weight of what they are carrying. Sit with their feelings first without forced cheerleading or minimizing their struggles. Reassure them that it is completely okay to feel this way.
  2. Gentle, Functional Coping: Offer bite-sized, practical mental wellness tools suited to their situation (e.g. 4-7-8 deep breathing, 5-4-3-2-1 sensory grounding, cognitive reframing, unclamping the jaw and dropping shoulders, or stepping away from screens).
  3. Thoughtful Reflection: Encourage self-discovery by asking a gentle, open-ended question that helps them reflect and get clearer about what they need right now.
- Tone: Warm, supportive, conversational, and genuinely caring. Avoid clinical jargon, diagnostic labels, and sounding like a robotic textbook.
- Formatting: Do NOT use em-dashes (-) or double hyphens (--) in your response. Avoid rigid bulleted lists or bold key-term headers. Write in natural, comforting, flowing paragraphs.
- Safety: If a student describes feelings of severe crisis or self-harm, respond with immediate compassion and care, validate their pain, and gently remind them that they do not have to carry this alone and encourage them to connect with real-time support or university crisis hotlines.`;

// Helper to get the primary model name (prioritizing cheap, supported Flash models over Pro)
function getPrimaryModelName(): string {
  const envModel = env.GEMINI_MODEL;
  if (
    envModel &&
    !envModel.toLowerCase().includes('pro') &&
    !envModel.toLowerCase().includes('2.0-') &&
    !envModel.toLowerCase().includes('gemma')
  ) {
    return envModel;
  }
  return 'gemini-2.5-flash';
}

// Get or initialize a session (Calculated dynamically per User)
router.get(
  '/session/:sessionId',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User ID missing from token' });
        return;
      }

      const dailyRequestsUsed = await getDailyRequestsUsed(userId);
      const primaryModel = getPrimaryModelName();
      const maxRequests = getMaxRequestsForModel(primaryModel);
      const remainingPercent = Math.max(0, 100 - Math.round((dailyRequestsUsed / maxRequests) * 100));

      res.status(200).json({
        sessionId: req.params.sessionId,
        tokensUsed: dailyRequestsUsed,
        maxTokens: maxRequests,
        remainingPercent,
      });
    } catch (err) {
      console.error('Error fetching session details:', err);
      res.status(500).json({ error: 'Failed to fetch session details' });
    }
  }
);

// Diagnostic route to check live backend connectivity
router.get('/diagnose', async (req: Request, res: Response) => {
  const diagnostics: any = {
    env: {
      NODE_ENV: process.env.NODE_ENV,
      PORT: env.PORT,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
      GEMINI_API_KEY_DEFINED: !!env.GEMINI_API_KEY,
      GEMINI_API_KEY_LENGTH: env.GEMINI_API_KEY?.length || 0,
      GEMINI_MODEL: env.GEMINI_MODEL,
    },
    database: {
      status: 'unknown',
    },
    gemini: {
      status: 'unknown',
    }
  };

  try {
    const userCount = await prisma.user.count();
    diagnostics.database = { status: 'success', userCount };
  } catch (err: any) {
    diagnostics.database = { status: 'failed', error: err.message || err };
  }

  try {
    const genAI = getGeminiClient();
    if (!genAI) {
      diagnostics.gemini = { status: 'failed', error: 'Gemini client not initialized' };
    } else {
      const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
      const result = await Promise.race([
        model.generateContent('Hi'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 5 seconds')), 5000))
      ]) as any;
      diagnostics.gemini = { status: 'success', text: result.response?.text() || 'no response text' };
    }
  } catch (err: any) {
    diagnostics.gemini = { status: 'failed', error: err.message || err };
  }

  res.status(200).json(diagnostics);
});

// Process a message
router.post(
  '/message',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.sub;
      if (!userId) {
        res.status(401).json({ error: 'User ID missing from token' });
        return;
      }

      const { sessionId, message, history = [] } = req.body as {
        sessionId: string;
        message: string;
        history: { sender: 'user' | 'model'; text: string }[];
      };

      if (!sessionId || !message) {
        res.status(400).json({ error: 'Session ID and message are required' });
        return;
      }

      const primaryModel = getPrimaryModelName();
      const maxRequests = getMaxRequestsForModel(primaryModel);
      const dailyRequestsUsed = await getDailyRequestsUsed(userId);
      let remainingPercent = Math.max(0, 100 - Math.round((dailyRequestsUsed / maxRequests) * 100));

      // If no capacity remaining, return static fallback
      if (remainingPercent <= 0) {
        // Log static placeholder usage in DB (anonymized) to ensure daily limit is recorded
        await prisma.chatMessage.create({
          data: {
            userId,
            sender: 'USER',
            message: 'WriteMindly User Message (Limit Exceeded)',
          },
        });

        await prisma.chatMessage.create({
          data: {
            userId,
            sender: 'AI',
            message: 'WriteMindly AI Response (Limit Exceeded)',
          },
        });

        res.status(200).json({
          response: "I think we've covered a lot today. Let's take a deep breath, stretch, and sit with these feelings for a moment. You're doing okay.",
          remainingPercent: 0,
          tokensUsed: dailyRequestsUsed,
        });
        return;
      }

      // Log user message in DB
      await prisma.chatMessage.create({
        data: {
          userId,
          sender: 'USER',
          message: 'WriteMindly User Message',
        },
      });

      let replyText = "";
      try {
        const genAI = getGeminiClient();
        if (!genAI) {
          throw new Error('Gemini API key is not configured');
        }

        // Sequential fallback list prioritizing cheap, high-context Flash models
        const primaryModel = getPrimaryModelName();
        const modelsToTry = [
          primaryModel,
          'gemini-3.5-flash',
          'gemini-2.5-flash',
          'gemini-2.5-flash-lite',
          env.GEMINI_MODEL || 'gemini-2.5-flash',
          'gemini-2.5-pro'
        ];
        const uniqueModelsToTry = Array.from(new Set(modelsToTry.filter(m => m && !m.toLowerCase().includes('2.0-') && !m.toLowerCase().includes('gemma'))));

        let apiSuccess = false;
        let lastError: any = null;

        for (const modelName of uniqueModelsToTry) {
          try {
            console.log(`[WriteMindly] Attempting chat response using model: ${modelName}`);
            const model = genAI.getGenerativeModel({
              model: modelName,
              systemInstruction: SYSTEM_INSTRUCTION,
            });

            // Convert incoming history to Gemini history format (excluding current message)
            const geminiHistory = history.map((h) => ({
              role: h.sender === 'user' ? 'user' : 'model',
              parts: [{ text: h.text }],
            }));

            const chat = model.startChat({
              history: geminiHistory,
            });

            const result = await Promise.race([
              chat.sendMessage(message),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API call timed out')), 8000))
            ]) as any;
            replyText = result.response.text();

            if (replyText) {
              console.log(`[WriteMindly] ✅ Success! Response generated using model: ${modelName}`);
              apiSuccess = true;
              break;
            }
          } catch (modelError: any) {
            console.warn(`[WriteMindly] ⚠️ Model ${modelName} call failed or quota exceeded:`, modelError.message || modelError);
            lastError = modelError;
            // Continue to the next model in the fallback array
          }
        }

        if (!apiSuccess) {
          throw lastError || new Error('All configured models failed to generate response');
        }
      } catch (apiError) {
        console.error('All model attempts failed in fallback chain, falling back to static response:', apiError);
        replyText = "I hear you, and it's completely okay to feel this way. Things might feel heavy right now, but I'm here sitting with you. Maybe you should try letting go of one minor task tonight or stepping outside for a brief walk to get some air.\n\nWhat has been contributing the most to this feeling today, and is there anything specific we can think through together?";
      }

      // Log AI response in DB
      await prisma.chatMessage.create({
        data: {
          userId,
          sender: 'AI',
          message: 'WriteMindly AI Response',
        },
      });

      const updatedRequestsUsed = dailyRequestsUsed + 1;
      remainingPercent = Math.max(0, 100 - Math.round((updatedRequestsUsed / maxRequests) * 100));

      res.status(200).json({
        response: replyText,
        remainingPercent,
        tokensUsed: updatedRequestsUsed,
      });
    } catch (error) {
      console.error('Error in WriteMindly chat route:', error);
      res.status(500).json({ error: 'An error occurred while generating the response' });
    }
  }
);

// Clear/delete a session (Stateless now, return success)
router.delete(
  '/session/:sessionId',
  authenticateJWT,
  authorizeRoles('STUDENT', 'ADMIN'),
  async (_req: Request, res: Response) => {
    res.status(200).json({ success: true });
  }
);

export default router;
