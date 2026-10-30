import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import authRouter from './routes/auth';
import quizzesRouter from './routes/quizzes';
import studentsRouter from './routes/students';
import adminRouter from './routes/admin';
import universityRouter from './routes/university';
import chatRouter from './routes/chat';
import contactsRouter from './routes/contacts';
import talkRouter from './routes/talk';
import v1AdminRouter from './routes/v1/admin';
import v1CounselorsRouter from './routes/v1/counselors';
import v1StudentsRouter from './routes/v1/students';
import { startReminderScheduler } from './utils/reminderService';
import { ensureContactRequestSchema } from './services/contactSchema';

const app = express();

// Trust reverse proxies (CloudFront / ALB / Nginx) so req.ip and rate limiters
// inspect X-Forwarded-For rather than treating all production traffic as 127.0.0.1
app.set('trust proxy', true);

// Secure security headers
app.use(helmet());

// Configure secure CORS policy checks
const allowedOrigins = env.ALLOWED_ORIGINS.split(',');
const mobileOrigins = [
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const isWellmindly = /^https:\/\/(.*\.)?wellmindly\.com(:[0-9]+)?$/i.test(origin);
      const isLocalhost = /^https?:\/\/localhost(:[0-9]+)?$/i.test(origin);
      const isCapacitor = /^(capacitor|ionic):\/\/localhost/i.test(origin);
      if (
        isWellmindly ||
        isLocalhost ||
        isCapacitor ||
        allowedOrigins.indexOf(origin) !== -1 ||
        mobileOrigins.indexOf(origin) !== -1 ||
        allowedOrigins.includes('*')
      ) {
        return callback(null, true);
      } else {
        return callback(null, false);
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// API rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  skip: () => env.RATE_LIMIT_MAX <= 0,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
});

const strictAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  skip: () => env.AUTH_RATE_LIMIT_MAX <= 0,
  message: { error: 'Too many authentication attempts, please try again after a minute' },
});

// Public contact & newsletter bot protection (POST only, does not affect admin GET or student traffic)
const publicContactLimiter = rateLimit({
  windowMs: env.WAITLIST_RATE_LIMIT_WINDOW_MS,
  max: env.WAITLIST_RATE_LIMIT_IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  skip: (req) => req.method !== 'POST' || process.env.NODE_ENV === 'test',
  message: { error: 'Too many contact submissions from this IP, please try again after a few minutes' },
});

// Mount limiters to endpoints
app.use('/api', generalLimiter);
app.use('/api/contacts/general', publicContactLimiter);
app.use('/api/contacts/university', publicContactLimiter);
app.use('/api/contacts/counselor', publicContactLimiter);
app.use('/api/auth/register', strictAuthLimiter);
app.use('/api/auth/login', strictAuthLimiter);
app.use('/api/auth/forgot-password', strictAuthLimiter);
app.use('/api/auth/delete-account', strictAuthLimiter);
app.use('/api/v1/counselors/login', strictAuthLimiter);
app.use('/api/v1/counselors/forgot-password', strictAuthLimiter);
app.use('/api/v1/counselors/reset-password', strictAuthLimiter);

// Legacy routes
app.use('/api/auth', authRouter);
app.use('/api/quizzes', quizzesRouter);
app.use('/api/students', studentsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/university', universityRouter);
app.use('/api/chat', chatRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/talk', talkRouter);

// API v1 Production Endpoints
app.use('/api/v1/admin', v1AdminRouter);
app.use('/api/v1/counselors', v1CounselorsRouter);
app.use('/api/v1/students', v1StudentsRouter);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'API is healthy' });
});

app.get('/api/health/db', async (req, res) => {
  const dns = require('dns').promises;
  let dnsLookup: any = null;
  let egressIp: any = null;
  let dbStatus: any = null;

  try {
    const https = require('https');
    egressIp = await new Promise((resolve) => {
      https.get('https://api.ipify.org?format=json', { timeout: 3000 }, (r: any) => {
        let d = '';
        r.on('data', (c: any) => d += c);
        r.on('end', () => {
          try { resolve(JSON.parse(d).ip); } catch { resolve(d); }
        });
      }).on('error', (e: any) => resolve(e.message));
    });
  } catch (e: any) {
    egressIp = e.message;
  }

  try {
    const parsed = new URL(env.DATABASE_URL);
    dnsLookup = await dns.lookup(parsed.hostname);
  } catch (e: any) {
    dnsLookup = e.message;
  }

  try {
    const { Client } = require('pg');
    const c = new Client({
      connectionString: env.DATABASE_URL.split('?')[0],
      connectionTimeoutMillis: 3000,
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    const q = await c.query('SELECT 1 as ok');
    await c.end();
    dbStatus = 'CONNECTED';
  } catch (e: any) {
    dbStatus = { error: e.message, code: e.code };
  }

  res.json({
    egressIp,
    dnsLookup,
    dbStatus,
    dbUrlConfigured: env.DATABASE_URL ? 'PRESENT (length ' + env.DATABASE_URL.length + ')' : 'MISSING',
  });
});

// Unmatched routes. Express's default answer is an HTML page, so a client that
// calls a path this build does not have gets `<!DOCTYPE ...` where it expected
// JSON and throws inside res.json() rather than reading the status. Only /api is
// claimed here; anything else is left to Express.
app.use('/api', (req: express.Request, res: express.Response) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `No such endpoint: ${req.method} ${req.baseUrl}${req.path}` },
  });
});

// Last-resort error handler. Express's own handler answers with an HTML page
// containing the stack trace and absolute file paths, which is not something a
// client should ever be shown; anything that escapes a route lands here instead
// and gets the same JSON envelope the rest of the API uses.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const code = err?.code as string | undefined;
  // Prisma's known request errors carry a code we can map to a real status.
  const mapped =
    code === 'P2025' ? { status: 404, code: 'NOT_FOUND', message: 'Record not found' } :
    code === 'P2002' ? { status: 409, code: 'ALREADY_EXISTS', message: 'That value is already taken' } :
    code === 'P2003' ? { status: 409, code: 'IN_USE', message: 'That record is still referenced elsewhere' } :
    null;

  if (!mapped) console.error('Unhandled route error:', err);
  const body = mapped ?? { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong' };
  res.status(body.status).json({
    success: false,
    error: { code: body.code, message: body.message },
  });
});

// Ensure contact and waitlist database schema is initialized and backward-compatible
ensureContactRequestSchema().catch((err) => {
  console.warn('Initial ensureContactRequestSchema check warning:', err?.message || err);
});

// Start background automated session reminder scheduler
if (env.ENABLE_REMINDER_SCHEDULER) {
  startReminderScheduler();
} else {
  console.log('Reminder scheduler disabled (ENABLE_REMINDER_SCHEDULER=false)');
}

app.listen(process.env.PORT || env.PORT, () => {
  console.log(`Server is running on port ${env.PORT}`);
});

export default app;
