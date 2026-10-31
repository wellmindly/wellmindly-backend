"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const supertest_1 = __importDefault(require("supertest"));
const app_1 = __importDefault(require("../app"));
const jwt_1 = require("../lib/jwt");
const prisma_1 = __importDefault(require("../lib/prisma"));
const crypto_1 = __importDefault(require("crypto"));
(0, vitest_1.describe)('Counselor Profile Picture Upload & Serving End-to-End', () => {
    const counselorUser = {
        id: 'counselor-user-test-1',
        email: 'counselor.upload.test@wellmindly.com',
        role: 'COUNSELOR',
    };
    const adminUser = {
        id: 'admin-user-test-1',
        email: 'admin.test@wellmindly.com',
        role: 'ADMIN',
    };
    const studentUser = {
        id: 'student-user-test-1',
        email: 'student.test@wellmindly.com',
        role: 'STUDENT',
    };
    const counselorToken = (0, jwt_1.signToken)({
        sub: counselorUser.id,
        email: counselorUser.email,
        role: counselorUser.role,
        universityId: null,
    });
    const adminToken = (0, jwt_1.signToken)({
        sub: adminUser.id,
        email: adminUser.email,
        role: adminUser.role,
        universityId: null,
    });
    const studentToken = (0, jwt_1.signToken)({
        sub: studentUser.id,
        email: studentUser.email,
        role: studentUser.role,
        universityId: null,
    });
    (0, vitest_1.it)('can upload a counselor avatar and serve it back with Cross-Origin headers', async () => {
        const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const uploadRes = await (0, supertest_1.default)(app_1.default)
            .post('/api/v1/counselors/me/upload')
            .set('Authorization', `Bearer ${counselorToken}`)
            .send({
            fileName: 'test-avatar.png',
            mimeType: 'image/png',
            base64Data: `data:image/png;base64,${samplePngBase64}`,
            folder: 'avatars',
        });
        (0, vitest_1.expect)(uploadRes.status).toBe(200);
        (0, vitest_1.expect)(uploadRes.body.success).toBe(true);
        (0, vitest_1.expect)(uploadRes.body.data.url).toBeDefined();
        const avatarUrl = uploadRes.body.data.url;
        (0, vitest_1.expect)(avatarUrl).toContain('/api/v1/counselors/assets/avatars/');
        // Fetch the asset using GET
        const assetRes = await (0, supertest_1.default)(app_1.default).get(avatarUrl);
        (0, vitest_1.expect)(assetRes.status).toBe(200);
        (0, vitest_1.expect)(assetRes.headers['content-type']).toContain('image/png');
        // Ensure Cross-Origin embedding is permitted for frontends
        (0, vitest_1.expect)(assetRes.headers['cross-origin-resource-policy']).toBe('cross-origin');
        (0, vitest_1.expect)(assetRes.headers['access-control-allow-origin']).toBe('*');
    });
    (0, vitest_1.it)('allows invited counselors to upload avatar during setup and saves it', async () => {
        // 1. Create invitation
        const token = crypto_1.default.randomBytes(24).toString('hex');
        const email = `test.setup.${Date.now()}@example.com`;
        await prisma_1.default.counselorInvitation.create({
            data: {
                token,
                email,
                firstName: 'SetupTest',
                lastName: 'Counselor',
                expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
            },
        });
        // 2. Upload avatar with invitation token
        const samplePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const uploadRes = await (0, supertest_1.default)(app_1.default)
            .post('/api/v1/counselors/setup-upload')
            .send({
            token,
            fileName: 'setup-photo.png',
            mimeType: 'image/png',
            base64Data: `data:image/png;base64,${samplePngBase64}`,
        });
        (0, vitest_1.expect)(uploadRes.status).toBe(200);
        (0, vitest_1.expect)(uploadRes.body.success).toBe(true);
        const uploadedAvatarUrl = uploadRes.body.data.url;
        (0, vitest_1.expect)(uploadedAvatarUrl).toContain('/api/v1/counselors/assets/avatars/');
        // 3. Complete profile setup with the uploaded avatar
        const setupRes = await (0, supertest_1.default)(app_1.default)
            .post('/api/v1/counselors/setup-profile')
            .send({
            token,
            password: 'Password123!',
            credentials: 'Ph.D. Clinical Psychology',
            specializations: ['Stress', 'Anxiety'],
            bio: 'Compassionate counselor bio',
            phone: '+1 555-0199',
            timezone: 'UTC',
            avatarUrl: uploadedAvatarUrl,
        });
        (0, vitest_1.expect)(setupRes.status).toBe(201);
        (0, vitest_1.expect)(setupRes.body.success).toBe(true);
        // 4. Verify profile in DB has the avatarUrl
        const createdUser = await prisma_1.default.user.findUnique({
            where: { email },
            include: { counselorProfile: true },
        });
        (0, vitest_1.expect)(createdUser).toBeDefined();
        (0, vitest_1.expect)(createdUser?.counselorProfile?.avatarUrl).toBe(uploadedAvatarUrl);
        // Clean up
        await prisma_1.default.counselorProfile.deleteMany({ where: { userId: createdUser.id } });
        await prisma_1.default.user.delete({ where: { id: createdUser.id } });
    });
    (0, vitest_1.it)('normalizes avatar URLs in student, public contacts, and admin counselor directories', async () => {
        // 1. Student counselors endpoint
        const studentRes = await (0, supertest_1.default)(app_1.default)
            .get('/api/v1/students/counselors')
            .set('Authorization', `Bearer ${studentToken}`);
        (0, vitest_1.expect)(studentRes.status).toBe(200);
        (0, vitest_1.expect)(studentRes.body.success).toBe(true);
        for (const counselor of studentRes.body.data) {
            if (counselor.avatarUrl) {
                // Must not contain direct s3 aws host
                (0, vitest_1.expect)(counselor.avatarUrl).not.toContain('.amazonaws.com/');
            }
        }
        // 2. Public contacts coaches endpoint
        const coachesRes = await (0, supertest_1.default)(app_1.default).get('/api/contacts/coaches');
        (0, vitest_1.expect)(coachesRes.status).toBe(200);
        (0, vitest_1.expect)(coachesRes.body.success).toBe(true);
        for (const coach of coachesRes.body.coaches) {
            if (coach.avatarUrl) {
                (0, vitest_1.expect)(coach.avatarUrl).not.toContain('.amazonaws.com/');
            }
        }
        // 3. Admin counselors endpoint
        const adminRes = await (0, supertest_1.default)(app_1.default)
            .get('/api/v1/admin/counselors')
            .set('Authorization', `Bearer ${adminToken}`);
        (0, vitest_1.expect)(adminRes.status).toBe(200);
        (0, vitest_1.expect)(adminRes.body.success).toBe(true);
        for (const c of adminRes.body.data) {
            if (c.avatarUrl) {
                (0, vitest_1.expect)(c.avatarUrl).not.toContain('.amazonaws.com/');
            }
        }
    });
});
