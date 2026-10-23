import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env';

// Initialize the Gemini API client if API key is provided
let genAI: GoogleGenerativeAI | null = null;
if (env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
}

/**
 * Gets the raw GoogleGenerativeAI client instance.
 * Useful for future integrations like WriteMindly chat sessions.
 */
export function getGeminiClient(): GoogleGenerativeAI | null {
  return genAI;
}

/**
 * Returns a new chat session for conversation-based features.
 * Can be reused in future chat integrations like WriteMindly.
 */
export function getGeminiChatSession(systemInstruction?: string) {
  if (!genAI) {
    throw new Error('Gemini API client is not initialized. Please set GEMINI_API_KEY.');
  }
  const model = genAI.getGenerativeModel({
    model: env.GEMINI_MODEL || 'gemini-3.5-flash',
    systemInstruction,
  });
  return model.startChat();
}

export interface QuizFeedback {
  headline: string;
  narrative: string;
  tip: string;
  insights: string[];
}

/**
 * Generates custom, brand-aligned feedback for a quiz result using Gemini.
 * Falls back to null if Gemini is disabled or fails.
 */
export async function generateQuizFeedback(
  quizTitle: string,
  category: string,
  overallScore: number,
  maxScore: number,
  classification: string
): Promise<QuizFeedback | null> {
  if (!genAI) {
    console.log('Gemini API key is not configured. Falling back to static client responses.');
    return null;
  }

  const modelsToTry = Array.from(new Set([
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.5-pro'
  ])).filter(m => m && !m.toLowerCase().includes('2.0-') && !m.toLowerCase().includes('gemma'));

  const systemInstruction = `You are an AI assistant helping a student understand their self-reflection quiz results.
Speak in the WellMindly brand voice:
- Tone: A thoughtful older friend who actually gets it.
- Style: Short sentences. Plain words. No wellness-speak.
- STRICT BANNED WORDS: NEVER use the words "journey", "wellness", "mental health", "transform", "empower", "resilience". If you need to refer to these, describe the feeling instead (e.g. "how you are doing", "feeling steady", "handling stress", "getting clearer").
- Realism: Don't cheerlead. Don't end every line on hope. Sit in the reality of the feeling first. Describe the feeling, not the symptom (e.g. "can't switch off" instead of "anxiety").
- Promises: Promise less than you can deliver. Use words like "clearer" (never "better"), "a bit" (never "a lot"), or "understand" (never "fix/cure").
- STRICTLY FORBIDDEN FORMATTING: Do NOT use em-dashes (-) or double hyphens (--) in any of the returned fields (headline, narrative, tip, insights). Use normal punctuation like commas, colons, or standard hyphens instead.

You must return a valid JSON object matching this schema:
{
  "headline": "A short, warm, non-clinical title (e.g., 'When everything feels urgent...' or 'Doing it your own way')",
  "narrative": "A personal, supportive reflection of 2-3 short, clean sentences explaining what they might be feeling or carrying based on their result.",
  "tip": "One practical, low-effort advice action (e.g., 'Commit to just five minutes. Starting is the hard part, not finishing.')",
  "insights": [
    "A brand-aligned detailed observation about what they might be carrying (e.g., 'Saying yes to everyone else leaves you with a very quiet battery for yourself.')",
    "Another brand-aligned detailed insight based on their specific score/answers (e.g., 'Sleep has felt less like actual rest and more like just switching off the lights.')"
  ]
}`;

  const prompt = `
Quiz Title: ${quizTitle}
Category/Focus: ${category}
User Result Summary / Classification: ${classification}
Overall Score: ${overallScore} out of ${maxScore}

Provide personalized, brand-aligned feedback based on this result.`;

  let lastError: any = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`[aiFeedback] Attempting quiz feedback using model: ${modelName}`);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
        },
        systemInstruction,
      });

      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API call timed out')), 8000))
      ]) as any;
      const text = result.response.text();

      if (!text) {
        continue;
      }

      const feedback = JSON.parse(text) as QuizFeedback;

      // Safety check for empty or incorrect JSON fields
      if (feedback.headline && feedback.narrative && feedback.tip && Array.isArray(feedback.insights)) {
        console.log(`[aiFeedback] ✅ Success! Feedback generated using model: ${modelName}`);
        return feedback;
      }
    } catch (error: any) {
      console.warn(`[aiFeedback] ⚠️ Model ${modelName} call failed or quota exceeded:`, error.message || error);
      lastError = error;
    }
  }

  console.error('All model attempts failed in quiz feedback fallback chain:', lastError);
  return null;
}

/**
 * Parses classification field from database.
 * If serialized JSON (with aiFeedback), extracts clean classification and aiFeedback object.
 * Otherwise returns the raw value as classification.
 */
export function parseStoredClassification(val: string): { classification: string; aiFeedback?: QuizFeedback; answers?: any } {
  if (val && val.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object') {
        return {
          classification: parsed.classification || 'Completed',
          aiFeedback: parsed.aiFeedback,
          answers: parsed.answers || null,
        };
      }
    } catch (e) {
      // Ignore and fallback
    }
  }
  return { classification: val };
}

/**
 * Classifies if a note or reply contains crisis safety concerns (self-harm, suicide, violence).
 * Uses cheap, fast gemini-2.5-flash-lite and logs token costs.
 */
export async function classifyCrisisContent(
  content: string
): Promise<{ isCrisis: boolean; inputTokens: number; outputTokens: number }> {
  if (!genAI) {
    console.log('Gemini API key is not configured. Safety classifier bypassed.');
    return { isCrisis: false, inputTokens: 0, outputTokens: 0 };
  }

  const modelName = env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const systemInstruction = `You are an automated safety and crisis classifier for a student peer-support network.
Analyze the student's anonymous post content for any signs of:
- Suicidal ideation, intent, or planning
- Self-harm (cutting, burning, mutilation)
- Immediate threat of physical violence to self or others
- Severe active crisis requiring safety routing

Return a valid JSON object matching this schema:
{
  "isCrisis": boolean
}
Return true only if there is a real, active safety concern. Do not flag standard stress, study fatigue, or sadness unless it crosses into self-harm/suicidal expressions.`;

  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: 'application/json',
      },
      systemInstruction,
    });

    const result = (await Promise.race([
      model.generateContent(content),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Safety classifier timed out')), 5000))
    ])) as any;

    const text = result.response.text();
    if (!text) {
      return { isCrisis: false, inputTokens: 0, outputTokens: 0 };
    }

    const parsed = JSON.parse(text);
    const isCrisis = !!parsed.isCrisis;

    let inputTokens = 0;
    let outputTokens = 0;
    if (result.response.usageMetadata) {
      inputTokens = result.response.usageMetadata.promptTokenCount || 0;
      outputTokens = result.response.usageMetadata.candidatesTokenCount || 0;
    }

    return { isCrisis, inputTokens, outputTokens };
  } catch (err: any) {
    console.error('[safetyClassifier] ⚠️ Crisis classification failed, falling back to false:', err.message || err);
    // On error/timeout, we fall back to false but log it. Human moderation priority queue will act as safety net
    return { isCrisis: false, inputTokens: 0, outputTokens: 0 };
  }
}

// Deterministic crisis & safety heuristics (runs before AI and acts as guaranteed safety net)
const CRISIS_PATTERNS = [
  /\b(kill|end|take)\s+(my\s*self|my\s*life|it\s*all)\b/i,
  /\b(commit|attempt|thinking\s+of)\s+suicide\b/i,
  /\b(want\s+to|going\s+to|ready\s+to)\s+die\b/i,
  /\b(hang|shoot|poison|overdose|drown|suffocate)\s+(my\s*self|me)\b/i,
  /\b(cut|slit)\s+(my\s*wrist|my\s*throat|myself|my\s*arms?)\b/i,
  /\b(better\s+off\s+dead|no\s+reason\s+to\s+live|don'?t\s+want\s+to\s+wake\s+up)\b/i,
  /\b(suicidal|suicide|self[\s-]?harm)\b/i,
  /\b(kms|kys)\b/i,
];

const HARASSMENT_PATTERNS = [
  /\b(f+[\*u]+c*k+|s+[\*h!]+i*t+|b+[\*i!]+t*c*h+|c+[\*u]+n*t+|f+[\*a!]+g+[\*o0]+t+|n+[\*i!]+g+[\*e3a]+r*)\b/i,
  /\b(s+[\*u]+c*k\s+(my|me|your|a)|blow\s*job|send\s*nudes?|eat\s*my\s*ass)\b/i,
  /\b(whore|slut|bastard|retard|cunt)\b/i,
];

/**
 * Asynchronously moderates a note or reply for crisis and safety.
 * Evaluates:
 * 1. Suicide/self-harm/violence (isCrisis)
 * 2. Inappropriate/explicit/harassment content (isUnsafe)
 * Returns a JSON structure:
 * {
 *   isSafe: boolean,
 *   isCrisis: boolean,
 *   reason?: string
 * }
 */
export async function evaluateContentSafety(
  content: string
): Promise<{ isSafe: boolean; isCrisis: boolean; reason?: string; inputTokens: number; outputTokens: number }> {
  if (!content || !content.trim()) {
    return { isSafe: true, isCrisis: false, inputTokens: 0, outputTokens: 0 };
  }

  // 1. Check Deterministic Crisis Patterns (immediate distress, self-harm, suicide)
  for (const pattern of CRISIS_PATTERNS) {
    if (pattern.test(content)) {
      return {
        isSafe: false,
        isCrisis: true,
        reason: 'Immediate safety or crisis keyword detected',
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  // 2. Check Deterministic Harassment / Inappropriate Patterns
  for (const pattern of HARASSMENT_PATTERNS) {
    if (pattern.test(content)) {
      return {
        isSafe: false,
        isCrisis: false,
        reason: 'Inappropriate or harmful language detected',
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  // 3. If Gemini is configured, run deeper semantic analysis
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({
        model: env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const prompt = `You are a clinical safety and community moderation classifier for a university student mental health peer support wall.
Analyze the following text submitted by a student.
Evaluate for:
1. isCrisis: true if the text expresses explicit intent, plans, or imminent thoughts of suicide, self-harm, severe violence, or immediate danger.
2. isSafe: false if the text contains hate speech, severe harassment, sexually explicit solicitations, bullying, or illegal content.
Otherwise, isSafe should be true and isCrisis should be false. Normal expressions of sadness, stress, anxiety, or overwhelm are SAFE (isSafe: true, isCrisis: false).

Text to evaluate:
"""${content}"""

Return strictly a JSON object with this shape:
{
  "isSafe": boolean,
  "isCrisis": boolean,
  "reason": string
}`;

      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const parsed = JSON.parse(text);

      let inputTokens = 0;
      let outputTokens = 0;
      if (result.response.usageMetadata) {
        inputTokens = result.response.usageMetadata.promptTokenCount || 0;
        outputTokens = result.response.usageMetadata.candidatesTokenCount || 0;
      }

      return {
        isSafe: typeof parsed.isSafe === 'boolean' ? parsed.isSafe : true,
        isCrisis: typeof parsed.isCrisis === 'boolean' ? parsed.isCrisis : false,
        reason: parsed.reason || undefined,
        inputTokens,
        outputTokens,
      };
    } catch (err: any) {
      console.warn('[evaluateContentSafety] Gemini semantic check failed, using heuristic results:', err.message || err);
    }
  }

  return { isSafe: true, isCrisis: false, inputTokens: 0, outputTokens: 0 };
}

