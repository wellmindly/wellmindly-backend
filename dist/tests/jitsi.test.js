"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const jitsi_1 = require("../utils/jitsi");
(0, vitest_1.describe)('Jitsi Utilities (buildJitsiMeetingLink & extractJitsiRoomName)', () => {
    const originalEnv = process.env;
    (0, vitest_1.beforeEach)(() => {
        process.env = { ...originalEnv };
    });
    (0, vitest_1.afterEach)(() => {
        process.env = originalEnv;
    });
    (0, vitest_1.it)('correctly extracts room name from URL or raw name', () => {
        (0, vitest_1.expect)((0, jitsi_1.extractJitsiRoomName)('https://meet.wellmindly.com/room-abc')).toBe('room-abc');
        (0, vitest_1.expect)((0, jitsi_1.extractJitsiRoomName)('https://meet.jit.si/room-abc#jwt=xyz')).toBe('room-abc');
        (0, vitest_1.expect)((0, jitsi_1.extractJitsiRoomName)('https://meet.jit.si/room-abc?jwt=xyz')).toBe('room-abc');
        (0, vitest_1.expect)((0, jitsi_1.extractJitsiRoomName)('room-abc')).toBe('room-abc');
    });
    (0, vitest_1.it)('returns clean room link when JITSI_APP_SECRET is not configured', () => {
        delete process.env.JITSI_APP_SECRET;
        process.env.JITSI_DOMAIN = 'meet.wellmindly.com';
        const link = (0, jitsi_1.buildJitsiMeetingLink)({
            roomName: 'counseling-session-123',
            user: { id: 'u1', firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' },
            isModerator: false,
        });
        (0, vitest_1.expect)(link).toBe('https://meet.wellmindly.com/counseling-session-123');
    });
    (0, vitest_1.it)('generates signed JWT link with moderator=true for counselors when JITSI_APP_SECRET is set', () => {
        process.env.JITSI_DOMAIN = 'meet.wellmindly.com';
        process.env.JITSI_APP_ID = 'wellmindly';
        process.env.JITSI_APP_SECRET = 'test_secret_12345';
        const link = (0, jitsi_1.buildJitsiMeetingLink)({
            roomName: 'counseling-session-123',
            user: { id: 'c1', firstName: 'Dr. Jane', lastName: 'Doe', email: 'jane@wellmindly.com' },
            isModerator: true,
        });
        (0, vitest_1.expect)(link).toContain('https://meet.wellmindly.com/counseling-session-123#jwt=');
        const token = link.split('#jwt=')[1];
        const decoded = jsonwebtoken_1.default.verify(token, 'test_secret_12345');
        (0, vitest_1.expect)(decoded.aud).toBe('wellmindly');
        (0, vitest_1.expect)(decoded.iss).toBe('wellmindly');
        (0, vitest_1.expect)(decoded.sub).toBe('meet.wellmindly.com');
        (0, vitest_1.expect)(decoded.room).toBe('counseling-session-123');
        (0, vitest_1.expect)(decoded.context.user.name).toBe('Dr. Jane Doe');
        (0, vitest_1.expect)(decoded.context.user.email).toBe('jane@wellmindly.com');
        (0, vitest_1.expect)(decoded.context.user.moderator).toBe(true);
    });
    (0, vitest_1.it)('generates signed JWT link with moderator=false for students when JITSI_APP_SECRET is set', () => {
        process.env.JITSI_DOMAIN = 'meet.wellmindly.com';
        process.env.JITSI_APP_ID = 'wellmindly';
        process.env.JITSI_APP_SECRET = 'test_secret_12345';
        const link = (0, jitsi_1.buildJitsiMeetingLink)({
            baseLink: 'https://meet.wellmindly.com/counseling-session-456',
            user: { id: 's1', firstName: 'Bob', lastName: 'Student', email: 'bob@example.com' },
            isModerator: false,
        });
        (0, vitest_1.expect)(link).toContain('https://meet.wellmindly.com/counseling-session-456#jwt=');
        const token = link.split('#jwt=')[1];
        const decoded = jsonwebtoken_1.default.verify(token, 'test_secret_12345');
        (0, vitest_1.expect)(decoded.room).toBe('counseling-session-456');
        (0, vitest_1.expect)(decoded.context.user.name).toBe('Bob Student');
        (0, vitest_1.expect)(decoded.context.user.moderator).toBe(false);
    });
});
