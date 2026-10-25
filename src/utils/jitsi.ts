import jwt from 'jsonwebtoken';

export interface JitsiUser {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email: string;
  avatarUrl?: string | null;
}

export interface BuildJitsiLinkOptions {
  baseLink?: string;
  roomName?: string;
  user: JitsiUser;
  isModerator: boolean;
  expiresInSeconds?: number;
}

/**
 * Extracts the room name from a full Jitsi URL or returns the room name directly.
 */
export function extractJitsiRoomName(linkOrName: string): string {
  if (!linkOrName) return '';
  const clean = linkOrName.split('#')[0].split('?')[0];
  const parts = clean.split('/');
  return parts[parts.length - 1];
}

/**
 * Generates a signed Jitsi JWT link for a specific participant (Moderator vs Guest).
 * If JITSI_APP_SECRET is not configured, it gracefully returns the clean base room link.
 */
export function buildJitsiMeetingLink(options: BuildJitsiLinkOptions): string {
  const domain = process.env.JITSI_DOMAIN || 'meet.jit.si';
  const appId = process.env.JITSI_APP_ID || 'wellmindly';
  const secret = process.env.JITSI_APP_SECRET;

  const roomName = options.roomName || extractJitsiRoomName(options.baseLink || '');
  const baseMeetingUrl = `https://${domain}/${roomName}`;

  // If no secret is configured (e.g. local dev without self-hosted Jitsi), return standard room URL
  if (!secret) {
    return baseMeetingUrl;
  }

  const now = Math.floor(Date.now() / 1000);
  const ttl = options.expiresInSeconds || 60 * 60 * 6; // default 6 hours

  const fullName = `${options.user.firstName || ''} ${options.user.lastName || ''}`.trim() || options.user.email;

  const payload = {
    aud: appId,
    iss: appId,
    sub: domain,
    room: roomName,
    nbf: now - 10,
    exp: now + ttl,
    context: {
      user: {
        id: options.user.id,
        name: fullName,
        email: options.user.email,
        avatar: options.user.avatarUrl || undefined,
        moderator: Boolean(options.isModerator),
      },
      features: {
        livestreaming: false,
        recording: false,
        transcription: false,
      },
    },
  };

  const token = jwt.sign(payload, secret, { algorithm: 'HS256' });
  return `${baseMeetingUrl}#jwt=${token}`;
}
