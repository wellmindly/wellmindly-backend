import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { buildJitsiMeetingLink, extractJitsiRoomName } from '../utils/jitsi';

describe('Jitsi Utilities (buildJitsiMeetingLink & extractJitsiRoomName)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('correctly extracts room name from URL or raw name', () => {
    expect(extractJitsiRoomName('https://meet.wellmindly.com/room-abc')).toBe('room-abc');
    expect(extractJitsiRoomName('https://meet.jit.si/room-abc#jwt=xyz')).toBe('room-abc');
    expect(extractJitsiRoomName('https://meet.jit.si/room-abc?jwt=xyz')).toBe('room-abc');
    expect(extractJitsiRoomName('room-abc')).toBe('room-abc');
  });

  it('returns clean room link when JITSI_APP_SECRET is not configured', () => {
    delete process.env.JITSI_APP_SECRET;
    process.env.JITSI_DOMAIN = 'meet.wellmindly.com';

    const link = buildJitsiMeetingLink({
      roomName: 'counseling-session-123',
      user: { id: 'u1', firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' },
      isModerator: false,
    });

    expect(link).toBe('https://meet.wellmindly.com/counseling-session-123');
  });

  it('generates signed JWT link with moderator=true for counselors when JITSI_APP_SECRET is set', () => {
    process.env.JITSI_DOMAIN = 'meet.wellmindly.com';
    process.env.JITSI_APP_ID = 'wellmindly';
    process.env.JITSI_APP_SECRET = 'test_secret_12345';

    const link = buildJitsiMeetingLink({
      roomName: 'counseling-session-123',
      user: { id: 'c1', firstName: 'Dr. Jane', lastName: 'Doe', email: 'jane@wellmindly.com' },
      isModerator: true,
    });

    expect(link).toContain('https://meet.wellmindly.com/counseling-session-123#jwt=');

    const token = link.split('#jwt=')[1];
    const decoded = jwt.verify(token, 'test_secret_12345') as any;

    expect(decoded.aud).toBe('wellmindly');
    expect(decoded.iss).toBe('wellmindly');
    expect(decoded.sub).toBe('meet.wellmindly.com');
    expect(decoded.room).toBe('counseling-session-123');
    expect(decoded.context.user.name).toBe('Dr. Jane Doe');
    expect(decoded.context.user.email).toBe('jane@wellmindly.com');
    expect(decoded.context.user.moderator).toBe(true);
  });

  it('generates signed JWT link with moderator=false for students when JITSI_APP_SECRET is set', () => {
    process.env.JITSI_DOMAIN = 'meet.wellmindly.com';
    process.env.JITSI_APP_ID = 'wellmindly';
    process.env.JITSI_APP_SECRET = 'test_secret_12345';

    const link = buildJitsiMeetingLink({
      baseLink: 'https://meet.wellmindly.com/counseling-session-456',
      user: { id: 's1', firstName: 'Bob', lastName: 'Student', email: 'bob@example.com' },
      isModerator: false,
    });

    expect(link).toContain('https://meet.wellmindly.com/counseling-session-456#jwt=');

    const token = link.split('#jwt=')[1];
    const decoded = jwt.verify(token, 'test_secret_12345') as any;

    expect(decoded.room).toBe('counseling-session-456');
    expect(decoded.context.user.name).toBe('Bob Student');
    expect(decoded.context.user.moderator).toBe(false);
  });
});
