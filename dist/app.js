"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const env_1 = require("./config/env");
const auth_1 = __importDefault(require("./routes/auth"));
const quizzes_1 = __importDefault(require("./routes/quizzes"));
const students_1 = __importDefault(require("./routes/students"));
const admin_1 = __importDefault(require("./routes/admin"));
const university_1 = __importDefault(require("./routes/university"));
const chat_1 = __importDefault(require("./routes/chat"));
const contacts_1 = __importDefault(require("./routes/contacts"));
const talk_1 = __importDefault(require("./routes/talk"));
const admin_2 = __importDefault(require("./routes/v1/admin"));
const counselors_1 = __importDefault(require("./routes/v1/counselors"));
const students_2 = __importDefault(require("./routes/v1/students"));
const reminderService_1 = require("./utils/reminderService");
const app = (0, express_1.default)();
// Secure security headers
app.use((0, helmet_1.default)());
// Configure secure CORS policy checks
const allowedOrigins = env_1.env.ALLOWED_ORIGINS.split(',');
const mobileOrigins = ['http://localhost', 'capacitor://localhost'];
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin)
            return callback(null, true);
        const isWellmindly = /^https:\/\/(.*\.)?wellmindly\.com$/i.test(origin);
        if (isWellmindly ||
            allowedOrigins.indexOf(origin) !== -1 ||
            mobileOrigins.indexOf(origin) !== -1 ||
            allowedOrigins.includes('*')) {
            return callback(null, true);
        }
        else {
            return callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));
app.use(express_1.default.json());
// API rate limiting
const generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: env_1.env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
});
const strictAuthLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: env_1.env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again after a minute' },
});
// Mount limiters to endpoints
app.use('/api', generalLimiter);
app.use('/api/auth/register', strictAuthLimiter);
app.use('/api/auth/login', strictAuthLimiter);
app.use('/api/auth/forgot-password', strictAuthLimiter);
// Legacy routes
app.use('/api/auth', auth_1.default);
app.use('/api/quizzes', quizzes_1.default);
app.use('/api/students', students_1.default);
app.use('/api/admin', admin_1.default);
app.use('/api/university', university_1.default);
app.use('/api/chat', chat_1.default);
app.use('/api/contacts', contacts_1.default);
app.use('/api/talk', talk_1.default);
// API v1 Production Endpoints
app.use('/api/v1/admin', admin_2.default);
app.use('/api/v1/counselors', counselors_1.default);
app.use('/api/v1/students', students_2.default);
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'API is healthy' });
});
// Unmatched routes. Express's default answer is an HTML page, so a client that
// calls a path this build does not have gets `<!DOCTYPE ...` where it expected
// JSON and throws inside res.json() rather than reading the status. Only /api is
// claimed here; anything else is left to Express.
app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `No such endpoint: ${req.method} ${req.baseUrl}${req.path}` },
    });
});
// Last-resort error handler. Express's own handler answers with an HTML page
// containing the stack trace and absolute file paths, which is not something a
// client should ever be shown; anything that escapes a route lands here instead
// and gets the same JSON envelope the rest of the API uses.
app.use((err, _req, res, _next) => {
    const code = err?.code;
    // Prisma's known request errors carry a code we can map to a real status.
    const mapped = code === 'P2025' ? { status: 404, code: 'NOT_FOUND', message: 'Record not found' } :
        code === 'P2002' ? { status: 409, code: 'ALREADY_EXISTS', message: 'That value is already taken' } :
            code === 'P2003' ? { status: 409, code: 'IN_USE', message: 'That record is still referenced elsewhere' } :
                null;
    if (!mapped)
        console.error('Unhandled route error:', err);
    const body = mapped ?? { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong' };
    res.status(body.status).json({
        success: false,
        error: { code: body.code, message: body.message },
    });
});
// Start background automated session reminder scheduler
if (env_1.env.ENABLE_REMINDER_SCHEDULER) {
    (0, reminderService_1.startReminderScheduler)();
}
else {
    console.log('Reminder scheduler disabled (ENABLE_REMINDER_SCHEDULER=false)');
}
app.listen(process.env.PORT || env_1.env.PORT, () => {
    console.log(`Server is running on port ${env_1.env.PORT}`);
});
exports.default = app;
