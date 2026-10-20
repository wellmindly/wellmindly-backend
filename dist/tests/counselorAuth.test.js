"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const supertest_1 = __importDefault(require("supertest"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const app_1 = __importDefault(require("../app"));
const env_1 = require("../config/env");
const mockSendEmail = vitest_1.vi.fn().mockResolvedValue(true);
const mockFindUnique = vitest_1.vi.fn();
const mockUpdate = vitest_1.vi.fn();
vitest_1.vi.mock('../utils/mailer', () => ({
    sendEmail: (opts) => mockSendEmail(opts),
    getOtpTemplate: vitest_1.vi.fn().mockReturnValue('<html>OTP</html>'),
    getPasswordResetLinkTemplate: vitest_1.vi.fn().mockReturnValue('<html>RESET LINK</html>'),
}));
vitest_1.vi.mock('../lib/prisma', () => ({
    default: {
        user: {
            findUnique: (args) => mockFindUnique(args),
            update: (args) => mockUpdate(args),
        },
        auditLog: {
            create: vitest_1.vi.fn().mockResolvedValue({ id: 'audit-1' }),
        },
    },
}));
(0, vitest_1.describe)('Counselor Password Reset API Routes', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    const mockCounselor = {
        id: 'counselor-uuid-1',
        email: 'counselor@wellmindly.com',
        firstName: 'Dr. Jane',
        lastName: 'Doe',
        role: 'COUNSELOR',
        passwordHash: '$2b$10$existingHashVal12345678901234567890',
        counselorProfile: {
            id: 'profile-uuid-1',
            status: 'ACTIVE',
        },
    };
    (0, vitest_1.describe)('POST /api/v1/counselors/forgot-password', () => {
        (0, vitest_1.it)('should return 400 if email is missing', async () => {
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/forgot-password')
                .send({});
            (0, vitest_1.expect)(res.status).toBe(400);
            (0, vitest_1.expect)(res.body.success).toBe(false);
            (0, vitest_1.expect)(res.body.error.code).toBe('INVALID_INPUT');
        });
        (0, vitest_1.it)('should return 404 if user is not found or not a counselor', async () => {
            mockFindUnique.mockResolvedValueOnce(null);
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/forgot-password')
                .send({ email: 'unknown@wellmindly.com' });
            (0, vitest_1.expect)(res.status).toBe(404);
            (0, vitest_1.expect)(res.body.success).toBe(false);
            (0, vitest_1.expect)(res.body.error.code).toBe('USER_NOT_FOUND');
        });
        (0, vitest_1.it)('should send reset email and return success when counselor exists', async () => {
            mockFindUnique.mockResolvedValueOnce(mockCounselor);
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/forgot-password')
                .send({ email: 'Counselor@Wellmindly.com' });
            (0, vitest_1.expect)(res.status).toBe(200);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            (0, vitest_1.expect)(res.body.data.message).toContain('Password reset link has been sent');
            (0, vitest_1.expect)(mockSendEmail).toHaveBeenCalledTimes(1);
            (0, vitest_1.expect)(mockSendEmail).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                to: 'counselor@wellmindly.com',
                subject: vitest_1.expect.stringContaining('Reset Your Counselor Password'),
            }));
        });
    });
    (0, vitest_1.describe)('POST /api/v1/counselors/verify-reset-token', () => {
        (0, vitest_1.it)('should return 400 if token is missing', async () => {
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/verify-reset-token')
                .send({});
            (0, vitest_1.expect)(res.status).toBe(400);
            (0, vitest_1.expect)(res.body.success).toBe(false);
            (0, vitest_1.expect)(res.body.error.code).toBe('INVALID_INPUT');
        });
        (0, vitest_1.it)('should return 400 for an invalid token', async () => {
            mockFindUnique.mockResolvedValueOnce(mockCounselor);
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/verify-reset-token')
                .send({ token: 'invalid.jwt.token', email: mockCounselor.email });
            (0, vitest_1.expect)(res.status).toBe(400);
            (0, vitest_1.expect)(res.body.success).toBe(false);
            (0, vitest_1.expect)(res.body.error.code).toBe('INVALID_TOKEN');
        });
        (0, vitest_1.it)('should return valid=true for a legitimate reset token', async () => {
            mockFindUnique.mockResolvedValue(mockCounselor);
            const secret = `${env_1.env.JWT_SECRET}-${mockCounselor.passwordHash}`;
            const validToken = jsonwebtoken_1.default.sign({
                sub: mockCounselor.id,
                email: mockCounselor.email,
                role: mockCounselor.role,
                purpose: 'counselor_reset_password',
            }, secret, { expiresIn: '1h' });
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/verify-reset-token')
                .send({ token: validToken, email: mockCounselor.email });
            (0, vitest_1.expect)(res.status).toBe(200);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            (0, vitest_1.expect)(res.body.data.valid).toBe(true);
            (0, vitest_1.expect)(res.body.data.email).toBe(mockCounselor.email);
        });
    });
    (0, vitest_1.describe)('POST /api/v1/counselors/reset-password', () => {
        (0, vitest_1.it)('should return 400 if new password is too short', async () => {
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/reset-password')
                .send({ token: 'some-token', newPassword: '123' });
            (0, vitest_1.expect)(res.status).toBe(400);
            (0, vitest_1.expect)(res.body.success).toBe(false);
            (0, vitest_1.expect)(res.body.error.code).toBe('INVALID_INPUT');
        });
        (0, vitest_1.it)('should successfully reset password with valid token and update database', async () => {
            mockFindUnique.mockResolvedValue(mockCounselor);
            mockUpdate.mockResolvedValueOnce({
                ...mockCounselor,
                passwordHash: '$2b$10$newHashedPassword12345',
            });
            const secret = `${env_1.env.JWT_SECRET}-${mockCounselor.passwordHash}`;
            const validToken = jsonwebtoken_1.default.sign({
                sub: mockCounselor.id,
                email: mockCounselor.email,
                role: mockCounselor.role,
                purpose: 'counselor_reset_password',
            }, secret, { expiresIn: '1h' });
            const res = await (0, supertest_1.default)(app_1.default)
                .post('/api/v1/counselors/reset-password')
                .send({
                token: validToken,
                newPassword: 'MyNewSecurePassword!2026',
                email: mockCounselor.email,
            });
            (0, vitest_1.expect)(res.status).toBe(200);
            (0, vitest_1.expect)(res.body.success).toBe(true);
            (0, vitest_1.expect)(res.body.data.message).toContain('Password has been reset successfully');
            (0, vitest_1.expect)(mockUpdate).toHaveBeenCalledTimes(1);
            (0, vitest_1.expect)(mockUpdate).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
                where: { id: mockCounselor.id },
                data: vitest_1.expect.objectContaining({
                    passwordHash: vitest_1.expect.any(String),
                }),
            }));
        });
    });
});
