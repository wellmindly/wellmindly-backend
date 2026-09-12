"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = __importDefault(require("../lib/prisma"));
const jwt_1 = require("../utils/jwt");
const ai_1 = require("../utils/ai");
const enums_1 = require("../generated/prisma/enums");
const s3_1 = require("../utils/s3");
const router = (0, express_1.Router)();
/**
 * POST /api/admin/upload
 * Upload an image file to AWS S3 bucket wellmindly-assets (us-east-1)
 */
router.post('/upload', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN', 'SUPER_ADMIN'), async (req, res) => {
    try {
        const { fileName, mimeType, base64Data, folder } = req.body || {};
        if (!base64Data) {
            res.status(400).json({ error: 'base64Data is required' });
            return;
        }
        const cleanBase64 = base64Data.includes('base64,')
            ? base64Data.split('base64,')[1]
            : base64Data;
        const buffer = Buffer.from(cleanBase64, 'base64');
        const name = fileName || `avatar_${Date.now()}.png`;
        const type = mimeType || 'image/png';
        const result = await (0, s3_1.uploadToS3)(buffer, name, type, folder || 'avatars');
        res.status(200).json({
            success: true,
            message: 'File uploaded to AWS S3 successfully',
            url: result.url,
            key: result.key,
        });
    }
    catch (error) {
        console.error('Error uploading file to S3:', error);
        res.status(500).json({ error: 'Failed to upload file to S3' });
    }
});
/**
 * GET /api/admin/metrics
 *
 * Protected by administrative security middleware.
 * Returns structured response data summarizing all rows in the QuizResult collection
 * to output cross-sectional system metrics (total submissions grouped by active classifications).
 */
router.get('/metrics', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        // 1. Total submission count across the entire system
        const totalSubmissions = await prisma_1.default.quizResult.count();
        // Fetch all quiz results for in-memory grouping
        const allResultsForMetrics = await prisma_1.default.quizResult.findMany({
            select: {
                overallScore: true,
                classification: true,
                quizId: true,
                completedAt: true,
            }
        });
        // 2. Group by classification in-memory after parsing JSON structures
        const classificationMap = {};
        allResultsForMetrics.forEach(r => {
            const parsed = (0, ai_1.parseStoredClassification)(r.classification);
            const name = parsed.classification || 'Completed';
            if (!classificationMap[name]) {
                classificationMap[name] = { count: 0, sumScore: 0, maxScore: r.overallScore, minScore: r.overallScore };
            }
            const group = classificationMap[name];
            group.count++;
            group.sumScore += r.overallScore;
            if (r.overallScore > group.maxScore)
                group.maxScore = r.overallScore;
            if (r.overallScore < group.minScore)
                group.minScore = r.overallScore;
        });
        const classificationMetrics = Object.entries(classificationMap).map(([name, data]) => ({
            classification: name,
            count: data.count,
            averageScore: Math.round(data.sumScore / data.count),
            maxScore: data.maxScore,
            minScore: data.minScore
        }));
        // 3. Group by quiz: submissions per assessment type
        const quizGroups = await prisma_1.default.quizResult.groupBy({
            by: ['quizId'],
            _count: { id: true },
            _avg: { overallScore: true },
        });
        // Fetch quiz titles for display
        const quizIds = quizGroups.map((g) => g.quizId);
        const quizzes = await prisma_1.default.quiz.findMany({
            where: { id: { in: quizIds } },
            select: { id: true, title: true, category: true, maxScore: true },
        });
        const quizLookup = {};
        for (const q of quizzes) {
            quizLookup[q.id] = { title: q.title, category: q.category, maxScore: q.maxScore };
        }
        const quizMetrics = quizGroups.map((g) => ({
            quizId: g.quizId,
            title: quizLookup[g.quizId]?.title ?? 'Unknown',
            category: quizLookup[g.quizId]?.category ?? 'Unknown',
            maxScore: quizLookup[g.quizId]?.maxScore ?? 0,
            totalSubmissions: g._count.id,
            averageScore: g._avg.overallScore !== null ? Math.round(g._avg.overallScore) : 0,
        }));
        // 4. Submission volume over time: daily counts for trend charts
        const dailyVolume = {};
        for (const r of allResultsForMetrics) {
            const dayKey = r.completedAt.toISOString().slice(0, 10); // YYYY-MM-DD
            dailyVolume[dayKey] = (dailyVolume[dayKey] || 0) + 1;
        }
        const submissionTrend = Object.entries(dailyVolume).map(([date, count]) => ({
            date,
            count,
        })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        // 5. Total unique users who have submitted at least one quiz
        const uniqueUsers = await prisma_1.default.quizResult.groupBy({
            by: ['userId'],
        });
        // 6. Daily check-in mood, for the "Avg Daily Mood" tile on the admin overview.
        // The tile previously hardcoded a value because nothing here exposed one.
        // _avg is null when there are no rows, so the client must handle null.
        const mood = await prisma_1.default.dailyCheckin.aggregate({
            _avg: { rating: true },
            _count: { id: true },
        });
        res.status(200).json({
            totalSubmissions,
            totalUniqueUsers: uniqueUsers.length,
            classificationMetrics,
            quizMetrics,
            submissionTrend,
            avgDailyMood: mood._avg.rating,
            totalCheckins: mood._count.id,
        });
    }
    catch (error) {
        console.error('Error fetching admin metrics:', error);
        res.status(500).json({ error: 'Failed to fetch admin metrics' });
    }
});
/**
 * GET /api/admin/students
 * Retrieves all students.
 */
router.get('/students', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        const students = await prisma_1.default.user.findMany({
            // The v1 analytics endpoint counts students with `deletedAt: null`, so
            // without the same filter here the admin list is longer than the
            // headline figure sitting above it.
            where: { role: 'STUDENT', deletedAt: null },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                createdAt: true,
                university: {
                    select: {
                        name: true,
                        domain: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.status(200).json({ students });
    }
    catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({ error: 'Failed to fetch students' });
    }
});
/**
 * GET /api/admin/students/:id
 * Retrieves detailed student profile: checkins, chat messages, quiz results.
 */
router.get('/students/:id', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const studentId = req.params.id;
        const student = await prisma_1.default.user.findFirst({
            where: { id: studentId, role: 'STUDENT', deletedAt: null },
            include: {
                university: {
                    select: {
                        name: true,
                        domain: true,
                        verified: true,
                    },
                },
                dailyCheckins: {
                    orderBy: { createdAt: 'desc' },
                },
                chatMessages: {
                    orderBy: { createdAt: 'asc' },
                },
                quizResults: {
                    include: {
                        quiz: {
                            select: {
                                title: true,
                                category: true,
                                maxScore: true,
                            },
                        },
                        feedback: true,
                    },
                    orderBy: { completedAt: 'desc' },
                },
            },
        });
        if (!student) {
            res.status(404).json({ error: 'Student not found' });
            return;
        }
        res.status(200).json({ student });
    }
    catch (error) {
        console.error('Error fetching student details:', error);
        res.status(500).json({ error: 'Failed to fetch student details' });
    }
});
/**
 * GET /api/admin/quizzes
 * Retrieves all quizzes with questions and options.
 */
router.get('/quizzes', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        const quizzes = await prisma_1.default.quiz.findMany({
            include: {
                questions: {
                    include: {
                        options: true,
                    },
                    orderBy: { index: 'asc' },
                },
            },
            orderBy: { createdAt: 'asc' },
        });
        res.status(200).json({ quizzes });
    }
    catch (error) {
        console.error('Error fetching quizzes:', error);
        res.status(500).json({ error: 'Failed to fetch quizzes' });
    }
});
/**
 * GET /api/admin/feedbacks
 * Retrieves all submitted quiz feedbacks.
 */
router.get('/feedbacks', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        const feedbacks = await prisma_1.default.quizFeedback.findMany({
            include: {
                result: {
                    include: {
                        user: {
                            select: {
                                id: true,
                                email: true,
                                firstName: true,
                                lastName: true,
                            },
                        },
                        quiz: {
                            select: {
                                title: true,
                                category: true,
                                maxScore: true,
                            },
                        },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.status(200).json({ feedbacks });
    }
    catch (error) {
        console.error('Error fetching feedbacks:', error);
        res.status(500).json({ error: 'Failed to fetch feedbacks' });
    }
});
/**
 * GET /api/admin/quiz-results
 * Retrieves all quiz results in the system, optionally filtered by quizId.
 */
router.get('/quiz-results', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const quizId = req.query.quizId;
        const where = quizId ? { quizId } : {};
        const quizResults = await prisma_1.default.quizResult.findMany({
            where,
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
                quiz: {
                    select: {
                        title: true,
                        category: true,
                        maxScore: true,
                    },
                },
            },
            orderBy: { completedAt: 'desc' },
        });
        res.status(200).json({ quizResults });
    }
    catch (error) {
        console.error('Error fetching quiz results:', error);
        res.status(500).json({ error: 'Failed to fetch quiz results' });
    }
});
/**
 * GET /api/admin/quiz-results/:id
 * Retrieves detailed quiz submission with quiz questions and user info.
 */
router.get('/quiz-results/:id', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const id = req.params.id;
        const quizResult = await prisma_1.default.quizResult.findUnique({
            where: { id },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
                quiz: {
                    include: {
                        questions: {
                            include: {
                                options: true,
                            },
                            orderBy: { index: 'asc' },
                        },
                    },
                },
                feedback: true,
            },
        });
        if (!quizResult) {
            return res.status(404).json({ error: 'Quiz result not found' });
        }
        res.status(200).json({ quizResult });
    }
    catch (error) {
        console.error('Error fetching quiz result details:', error);
        res.status(500).json({ error: 'Failed to fetch quiz result details' });
    }
});
/**
 * GET /api/admin/talk/metrics
 * Calculate AI tokens cost and moderation metrics.
 */
router.get('/talk/metrics', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        const notesTokens = await prisma_1.default.talkNote.aggregate({
            _sum: { inputTokens: true, outputTokens: true }
        });
        const repliesTokens = await prisma_1.default.talkReply.aggregate({
            _sum: { inputTokens: true, outputTokens: true }
        });
        const totalInput = (notesTokens._sum.inputTokens || 0) + (repliesTokens._sum.inputTokens || 0);
        const totalOutput = (notesTokens._sum.outputTokens || 0) + (repliesTokens._sum.outputTokens || 0);
        // Gemini 2.5 Flash pricing: $0.075 / 1M input, $0.30 / 1M output
        const inputCost = (totalInput / 1000000) * 0.075;
        const outputCost = (totalOutput / 1000000) * 0.30;
        const totalCostUsd = Number((inputCost + outputCost).toFixed(5));
        const totalNotes = await prisma_1.default.talkNote.count();
        const totalReplies = await prisma_1.default.talkReply.count();
        const flaggedNotes = await prisma_1.default.talkNote.count({
            where: { status: { in: [enums_1.TalkStatus.FLAGGED, enums_1.TalkStatus.REJECTED] } }
        });
        const flaggedReplies = await prisma_1.default.talkReply.count({
            where: { status: { in: [enums_1.TalkStatus.FLAGGED, enums_1.TalkStatus.REJECTED] } }
        });
        const totalRooms = await prisma_1.default.talkRoom.count();
        res.status(200).json({
            totalCostUsd,
            totalInput,
            totalOutput,
            totalNotes,
            totalReplies,
            flaggedNotes,
            flaggedReplies,
            totalRooms
        });
    }
    catch (error) {
        console.error('Error fetching talk metrics:', error);
        res.status(500).json({ error: 'Failed to fetch talk metrics' });
    }
});
/**
 * GET /api/admin/talk/rooms
 * List all talk rooms.
 */
router.get('/talk/rooms', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        const rooms = await prisma_1.default.talkRoom.findMany({
            include: {
                _count: { select: { notes: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json({ rooms });
    }
    catch (error) {
        console.error('Error fetching talk rooms:', error);
        res.status(500).json({ error: 'Failed to fetch talk rooms' });
    }
});
/**
 * POST /api/admin/talk/rooms
 * Create a new talk room.
 */
router.post('/talk/rooms', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const { name, description } = (req.body || {});
        if (!name || name.trim().length === 0) {
            res.status(400).json({ error: 'Room name is required' });
            return;
        }
        const room = await prisma_1.default.talkRoom.create({
            data: {
                name: name.trim(),
                description: description?.trim()
            }
        });
        res.status(201).json({ room });
    }
    catch (error) {
        console.error('Error creating talk room:', error);
        res.status(500).json({ error: 'Failed to create talk room' });
    }
});
/**
 * PUT /api/admin/talk/rooms/:roomId
 * Toggle isActive state.
 */
router.put('/talk/rooms/:roomId', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const { isActive } = (req.body || {});
        const room = await prisma_1.default.talkRoom.update({
            where: { id: req.params.roomId },
            data: { isActive: !!isActive }
        });
        res.status(200).json({ room });
    }
    catch (error) {
        console.error('Error updating talk room:', error);
        res.status(500).json({ error: 'Failed to update talk room' });
    }
});
/**
 * DELETE /api/admin/talk/rooms/:roomId
 * Delete a talk room.
 */
router.delete('/talk/rooms/:roomId', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        await prisma_1.default.talkRoom.delete({
            where: { id: req.params.roomId }
        });
        res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('Error deleting talk room:', error);
        res.status(500).json({ error: 'Failed to delete talk room' });
    }
});
/**
 * GET /api/admin/talk/flagged
 * Retrieve flagged notes and replies.
 */
router.get('/talk/flagged', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (_req, res) => {
    try {
        const flaggedNotes = await prisma_1.default.talkNote.findMany({
            where: { status: { in: [enums_1.TalkStatus.FLAGGED, enums_1.TalkStatus.REJECTED] } },
            include: { room: true },
            orderBy: { createdAt: 'desc' }
        });
        const flaggedReplies = await prisma_1.default.talkReply.findMany({
            where: { status: { in: [enums_1.TalkStatus.FLAGGED, enums_1.TalkStatus.REJECTED] } },
            include: { note: { include: { room: true } } },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json({ flaggedNotes, flaggedReplies });
    }
    catch (error) {
        console.error('Error fetching flagged content:', error);
        res.status(500).json({ error: 'Failed to fetch flagged content' });
    }
});
/**
 * POST /api/admin/talk/flagged/:type/:id/resolve
 * Resolve action for flagged content.
 */
router.post('/talk/flagged/:type/:id/resolve', jwt_1.authenticateJWT, (0, jwt_1.authorizeRoles)('ADMIN'), async (req, res) => {
    try {
        const { type, id } = req.params;
        const { action } = (req.body || {});
        if (!['APPROVE', 'REJECT', 'DELETE'].includes(action)) {
            res.status(400).json({ error: 'Invalid resolution action' });
            return;
        }
        if (type === 'note') {
            if (action === 'APPROVE') {
                await prisma_1.default.talkNote.update({
                    where: { id },
                    data: { status: enums_1.TalkStatus.APPROVED, moderationReason: null }
                });
            }
            else if (action === 'REJECT') {
                await prisma_1.default.talkNote.update({
                    where: { id },
                    data: { status: enums_1.TalkStatus.REJECTED }
                });
            }
            else if (action === 'DELETE') {
                await prisma_1.default.talkNote.delete({ where: { id } });
            }
        }
        else if (type === 'reply') {
            if (action === 'APPROVE') {
                await prisma_1.default.talkReply.update({
                    where: { id },
                    data: { status: enums_1.TalkStatus.APPROVED, moderationReason: null }
                });
            }
            else if (action === 'REJECT') {
                await prisma_1.default.talkReply.update({
                    where: { id },
                    data: { status: enums_1.TalkStatus.REJECTED }
                });
            }
            else if (action === 'DELETE') {
                await prisma_1.default.talkReply.delete({ where: { id } });
            }
        }
        else {
            res.status(400).json({ error: 'Invalid content type' });
            return;
        }
        res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('Error resolving flagged content:', error);
        res.status(500).json({ error: 'Failed to resolve flagged content' });
    }
});
exports.default = router;
