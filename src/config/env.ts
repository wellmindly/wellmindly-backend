import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  GOOGLE_CLIENT_ID: z.string().optional().default('942167444638-jcpvjkm9j14lqj29lvn3gbcnju4nf5pt.apps.googleusercontent.com'),
  GOOGLE_CLIENT_SECRET: z.string().optional().default('dummy_secret'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional().default('info@wellmindly.com'),
  CONTACT_NOTIFY_TO: z.string().optional().default('info@wellmindly.com'),
  RESEND_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional().default('gemini-3.5-flash'),
  // 5173 student, 5174 counselor, 5175 auraflow, 5176 university. Kept in step
  // with each repo's vite.config so a fresh checkout with no .env can still
  // reach the API from every local portal.
  ALLOWED_ORIGINS: z.string().optional().default('http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176,https://wellmindly.com,https://admin.wellmindly.com,https://counselor.wellmindly.com,https://university.wellmindly.com,https://www.wellmindly.com,http://localhost,capacitor://localhost'),
  CHAT_SESSION_MAX_REQUESTS: z.coerce.number().default(100),
  // Requests per IP per 15 minutes against /api. Configurable only so a local
  // sanity sweep can hammer every route in one pass; deployed hosts should not
  // set it and keep the 100 default.
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  // Requests per IP per minute against /api/auth/login, /register and
  // /forgot-password. This was hardcoded at 5, which is too tight for the way
  // the product is actually deployed: a university NATs its whole campus behind
  // one public IP, so the sixth student to sign in within a minute was locked
  // out for reasons that had nothing to do with them. bcrypt already makes each
  // attempt expensive server-side, so 20/minute still leaves credential
  // stuffing hopeless while letting a shared IP behave normally.
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(20),
  // Set to 'false' on a developer machine so a local boot never mails real
  // students and counselors. Absent means on, so deployed behaviour is unchanged.
  ENABLE_REMINDER_SCHEDULER: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  AWS_REGION: z.string().optional().default('us-east-1'),
  AWS_S3_BUCKET: z.string().optional().default('wellmindly-assets'),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  COUNSELOR_PORTAL_URL: z
    .string()
    .url()
    .optional()
    .default('https://counselor.wellmindly.com'),
  STUDENT_PORTAL_URL: z
    .string()
    .url()
    .optional()
    .default('https://wellmindly.com'),
  ADMIN_PORTAL_URL: z
    .string()
    .url()
    .optional()
    .default('https://admin.wellmindly.com'),
  MAINTENANCE_KEY: z.string().optional().default('wellmindly_maint_2026_secure'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:\n', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
