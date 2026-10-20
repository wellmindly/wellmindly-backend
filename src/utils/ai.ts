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
  if (!content || typeof content !== 'string') {
    return { isSafe: true, isCrisis: false, inputTokens: 0, outputTokens: 0 };
  }

  const trimmed = content.trim();

  // 1. Guaranteed Local Deterministic Clinical Safety Gate
  for (const pattern of CRISIS_PATTERNS) {
    if (pattern.test(trimmed)) {
      console.warn(`[safetyEvaluator] 🚨 Local clinical heuristic triggered (Crisis): "${trimmed.slice(0, 40)}..."`);
      return {
        isSafe: false,
        isCrisis: true,
        reason: 'Mentions self-harm or suicidal intent',
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  for (const pattern of HARASSMENT_PATTERNS) {
    if (pattern.test(trimmed)) {
      console.warn(`[safetyEvaluator] ⚠️ Local heuristic triggered (Harassment): "${trimmed.slice(0, 40)}..."`);
      return {
        isSafe: false,
        isCrisis: false,
        reason: 'Contains explicit language or harassment',
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  if (!genAI) {
    return { isSafe: true, isCrisis: false, reason: undefined, inputTokens: 0, outputTokens: 0 };
  }

  const modelCandidates = [
    env.GEMINI_MODEL || 'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
  ];

  const systemInstruction = `You are a safety monitoring agent for a university student peer-support network (TalkMindly).
Analyze the post content for safety violations:
- Suicidal ideation, intent, or planning (isCrisis)
- Self-harm/mutilation (isCrisis)
- Severe active crisis requiring safety intervention (isCrisis)
- Bullying, hate speech, direct harassment, or sexual propositioning/explicit sexual comments (isUnsafe)
- Obfuscated profanity or bypass attempts (e.g., using asterisks, symbols, or punctuation to hide bad words like "fu*k", "f**k", "s*ck", "sh!t") (isUnsafe)
- Commercial advertisements, spam, or soliciting (isUnsafe)

Return a valid JSON object matching this schema:
{
  "isSafe": boolean,
  "isCrisis": boolean,
  "reason": string // If isSafe is false or isCrisis is true, write a short, friendly, empathetic explanation of why the message was flagged. Max 8 words.
}

Examples:
- "anyone wanna suck me" -> {"isSafe": false, "isCrisis": false, "reason": "Contains sexually explicit references"}
- "fu*k me" -> {"isSafe": false, "isCrisis": false, "reason": "Contains profanity or bypass attempts"}
- "I can't do this anymore, I'm going to end it tonight" -> {"isSafe": false, "isCrisis": true, "reason": "Mentions suicidal intent"}
- "I hate my group mates they are so stupid" -> {"isSafe": true, "isCrisis": false}
- "You are a disgusting fat cow" -> {"isSafe": false, "isCrisis": false, "reason": "Direct bullying and harassment"}

Be fair. Sadness, study fatigue, venting stress, and academic pressure are allowed. Only flag actual harassment, explicit vulgarity, obfuscated profanity bypasses, or safety crisis.`;

  for (const modelName of modelCandidates) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
        },
        systemInstruction,
      });

      const result = (await Promise.race([
        model.generateContent(trimmed),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Safety evaluator timed out')), 6000))
      ])) as any;

      const text = result.response.text();
      if (!text) continue;

      const parsed = JSON.parse(text);
      const isCrisis = parsed.isCrisis !== undefined ? !!parsed.isCrisis : (parsed.crisis !== undefined ? !!parsed.crisis : false);
      const isSafe = parsed.isSafe !== undefined ? !!parsed.isSafe : (parsed.safe !== undefined ? !!parsed.safe : true);
      const reason = parsed.reason || parsed.explanation || undefined;

      let inputTokens = 0;
      let outputTokens = 0;
      if (result.response.usageMetadata) {
        inputTokens = result.response.usageMetadata.promptTokenCount || 0;
        outputTokens = result.response.usageMetadata.candidatesTokenCount || 0;
      }

      return { isSafe: isSafe && !isCrisis, isCrisis, reason, inputTokens, outputTokens };
    } catch (err: any) {
      console.warn(`[safetyEvaluator] Model ${modelName} attempt error:`, err.message || err);
      // Try next model candidate
    }
  }

  console.error('[safetyEvaluator] ⚠️ All Gemini models failed or timed out. Local heuristics were clean.');
  return { isSafe: true, isCrisis: false, inputTokens: 0, outputTokens: 0 };
}

