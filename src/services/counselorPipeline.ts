import crypto from 'crypto';
import type { Request } from 'express';
import prisma from '../lib/prisma';
import { sendEmail } from '../utils/mailer';
import { escapeHtml } from '../utils/escapeHtml';
import { env } from '../config/env';

/**
 * Counselor onboarding pipeline shared by the admin "Counselor Applications"
 * view (/api/contacts/counselor) and the v1 admin counselor routes.
 *
 * A counselor is in exactly one admin list:
 *   - Applications: applied (CounselorOnboarding) and/or invited (CounselorInvitation)
 *     but has NOT activated yet.
 *   - Directory: has activated, i.e. a COUNSELOR user with a CounselorProfile exists
 *     (created by /v1/counselors/setup-profile, or by approve-onboard for an existing
 *     counselor account).
 * Activation is decided from the account itself, never from the invitation's `used`
 * flag or from audit-log timestamps, so the lists cannot drift apart.
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function counselorSetupUrl(req: Request, token: string): string {
  const host = req.get('host') || '';
  const origin = req.get('origin') || '';
  const isLocalDev = (host.includes('localhost') || host.includes('127.0.0.1')) && !origin.includes('wellmindly.com');
  const base = isLocalDev ? env.COUNSELOR_PORTAL_URL || 'http://localhost:5174' : 'https://counselor.wellmindly.com';
  return `${base}/setup-profile?token=${token}`;
}

/** Lower-cased emails (from `emails`) that belong to an activated counselor account. */
export async function findActivatedCounselorEmails(emails: string[]): Promise<Set<string>> {
  const wanted = Array.from(new Set(emails.map(normalizeEmail))).filter(Boolean);
  if (wanted.length === 0) return new Set();
  const users = await prisma.user.findMany({
    where: {
      email: { in: wanted, mode: 'insensitive' },
      role: 'COUNSELOR',
      counselorProfile: { isNot: null },
    },
    select: { email: true },
  });
  return new Set(users.map((u) => normalizeEmail(u.email)));
}

/** Marks any open invitation for this email as used (the counselor has activated). */
export async function closeInvitationFor(email: string): Promise<void> {
  await prisma.counselorInvitation.updateMany({
    where: { email: { equals: normalizeEmail(email), mode: 'insensitive' }, used: false },
    data: { used: true },
  });
}

type InviteTemplate = 'invite' | 'approved';

/**
 * Creates or refreshes (new token, new 7-day expiry) the invitation for `email` and
 * emails the setup link. Email failure is not an error: the caller gets
 * `emailDelivered: false` and the setup link to pass on by hand.
 */
export async function issueCounselorInvitation(
  req: Request,
  opts: { email: string; firstName: string; lastName: string; template?: InviteTemplate; credentials?: string }
) {
  const email = normalizeEmail(opts.email);
  const { firstName, lastName } = opts;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const invitation = await prisma.counselorInvitation.upsert({
    where: { email },
    update: { firstName, lastName, token, expiresAt, used: false },
    create: { email, firstName, lastName, token, expiresAt },
  });

  const setupUrl = counselorSetupUrl(req, token);
  const name = `${escapeHtml(firstName)} ${escapeHtml(lastName)}`;
  const approved = opts.template === 'approved';

  const emailDelivered = await sendEmail({
    to: email,
    sensitive: true,
    subject: approved
      ? 'Congratulations! Your WellMindly Counselor Application is Approved'
      : 'Invitation to Join WellMindly as a Counselor',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
        <h2 style="color: #4f46e5; margin-top: 0;">${approved ? 'Application Approved &amp; Onboarding Invitation' : 'Welcome to WellMindly'}</h2>
        <p>Hello <strong>${name}</strong>,</p>
        ${
          approved
            ? `<p>We are delighted to inform you that your counselor onboarding application${
                opts.credentials ? ` (<em>${escapeHtml(opts.credentials)}</em>)` : ''
              } has been <strong>approved</strong> by the WellMindly team!</p>`
            : '<p>You have been invited to join the WellMindly team as a professional counselor.</p>'
        }
        <p>Please click the button below to complete your registration, set up your password, and configure your counselor profile:</p>
        <p style="margin: 28px 0;">
          <a href="${setupUrl}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Set Up Counselor Profile</a>
        </p>
        <p style="color: #64748b; font-size: 13px;">Direct Link: <a href="${setupUrl}" style="color: #4f46e5;">${setupUrl}</a></p>
        <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This invitation link will expire in 7 days.</p>
      </div>
    `,
  });

  // The setup URL carries the invite token: it goes back to the admin, never to logs.
  console.log(`📧 [Counselor Invite] Setup link generated for ${email} (emailDelivered=${emailDelivered})`);

  return { invitation, setupUrl, emailDelivered };
}

export const REQUESTED_DOCS = ['Degree Certificate', 'Identity Document', 'Practice Standing License'];

export async function sendDocsRequestEmail(opts: { to: string; name: string; credentials?: string | null }): Promise<boolean> {
  return sendEmail({
    to: opts.to,
    subject: 'Document & Certificate Verification Request - WellMindly Counselor Application',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
        <h2 style="color: #4f46e5; margin-top: 0;">WellMindly Counselor Application Verification</h2>
        <p>Hello <strong>${escapeHtml(opts.name)}</strong>,</p>
        <p>Thank you for your interest in joining WellMindly as a counselor.${
          opts.credentials ? ` We are reviewing your credentials (<em>${escapeHtml(opts.credentials)}</em>).` : ''
        }</p>
        <p>To proceed with your onboarding, please reply to this email with the following documents attached:</p>
        <ul style="padding-left: 20px; color: #334155;">
          <li><strong>Degree &amp; Professional Certificates</strong> (M.A., Ph.D., RBT, or professional certifications)</li>
          <li><strong>Government-issued Identity Document</strong> (Passport or ID)</li>
          <li><strong>Proof of Professional License / Practice Standing</strong></li>
          <li>Any additional background documentation or reference letters</li>
        </ul>
        <p>If you have any questions, reply directly to this message or contact our team at <a href="mailto:wellmindly@gmail.com" style="color: #4f46e5;">wellmindly@gmail.com</a>.</p>
        <p style="margin-top: 24px; color: #64748b; font-size: 13px;">Warm regards,<br /><strong>The WellMindly Counselor Operations Team</strong></p>
      </div>
    `,
  });
}

export type PipelineStage = 'NEW_APPLICATION' | 'DOCS_REQUESTED' | 'INVITE_SENT' | 'INVITE_EXPIRED';

export interface PipelineItem {
  id: string;
  /** 'application' = public onboarding form submission; 'invitation' = direct admin invite. */
  source: 'application' | 'invitation';
  applicationId: string | null;
  invitationId: string | null;
  name: string;
  email: string;
  phone: string | null;
  credentials: string | null;
  experience: string | null;
  message: string | null;
  createdAt: Date;
  stage: PipelineStage;
  stageLabel: string;
  stageUpdatedAt: string | null;
  details: any;
  /** Set when the email already belongs to a non-counselor account (cannot be approved as-is). */
  conflictRole: string | null;
}

const STAGE_LABELS: Record<PipelineStage, string> = {
  NEW_APPLICATION: 'New Application',
  DOCS_REQUESTED: 'Degree & ID Docs Requested',
  INVITE_SENT: 'Invitation Link Dispatched',
  INVITE_EXPIRED: 'Invitation Expired',
};

/**
 * Everyone who applied or was invited and has not activated yet, newest first.
 * Duplicate applications for one email collapse into the newest one, and an
 * application with an invitation is a single row (not an application + an invite).
 */
export async function buildCounselorPipeline(): Promise<PipelineItem[]> {
  const [applications, invitations] = await Promise.all([
    prisma.counselorOnboarding.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.counselorInvitation.findMany({ where: { used: false }, orderBy: { createdAt: 'desc' } }),
  ]);

  const allEmails = [...applications.map((a) => a.email), ...invitations.map((i) => i.email)].map(normalizeEmail);
  const [activated, otherAccounts] = await Promise.all([
    findActivatedCounselorEmails(allEmails),
    prisma.user.findMany({
      where: { email: { in: Array.from(new Set(allEmails)), mode: 'insensitive' }, role: { not: 'COUNSELOR' } },
      select: { email: true, role: true },
    }),
  ]);
  const conflictMap = new Map(otherAccounts.map((u) => [normalizeEmail(u.email), u.role as string]));

  const invByEmail = new Map(invitations.map((i) => [normalizeEmail(i.email), i]));

  const appIds = applications.map((a) => a.id);
  const invIds = invitations.map((i) => i.id);
  const auditLogs = await prisma.auditLog.findMany({
    where: {
      action: { in: ['COUNSELOR_DOCS_REQUESTED', 'COUNSELOR_INVITE_SENT', 'INVITE_COUNSELOR'] },
      OR: [
        { targetEntity: 'CounselorOnboarding', targetId: { in: appIds } },
        { targetEntity: 'CounselorInvitation', targetId: { in: invIds } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  });
  const latestDocsLog = new Map<string, (typeof auditLogs)[number]>();
  for (const log of auditLogs) {
    if (log.action === 'COUNSELOR_DOCS_REQUESTED' && log.targetId && !latestDocsLog.has(log.targetId)) {
      latestDocsLog.set(log.targetId, log);
    }
  }

  const now = Date.now();
  const items: PipelineItem[] = [];
  const seen = new Set<string>();

  const stageFor = (inv: (typeof invitations)[number] | undefined, docsLog: (typeof auditLogs)[number] | undefined) => {
    const inviteTime = inv ? inv.createdAt.getTime() : 0;
    const docsTime = docsLog ? docsLog.createdAt.getTime() : 0;
    // The invitation row is upserted on every (re)send, so its createdAt is the first
    // send; use the later of the two for "most recent action wins".
    const invTouched = inv ? Math.max(inviteTime, inv.expiresAt.getTime() - INVITE_TTL_MS) : 0;
    if (docsLog && docsTime >= invTouched) {
      return { stage: 'DOCS_REQUESTED' as const, at: docsLog.createdAt.toISOString(), details: docsLog.details };
    }
    if (inv) {
      const expired = inv.expiresAt.getTime() < now;
      return {
        stage: expired ? ('INVITE_EXPIRED' as const) : ('INVITE_SENT' as const),
        at: new Date(invTouched).toISOString(),
        details: { expiresAt: inv.expiresAt },
      };
    }
    return { stage: 'NEW_APPLICATION' as const, at: null, details: null };
  };

  for (const app of applications) {
    const email = normalizeEmail(app.email);
    if (activated.has(email) || seen.has(email)) continue;
    seen.add(email);
    const inv = invByEmail.get(email);
    const docsLog = latestDocsLog.get(app.id) || (inv ? latestDocsLog.get(inv.id) : undefined);
    const s = stageFor(inv, docsLog);
    items.push({
      id: app.id,
      source: 'application',
      applicationId: app.id,
      invitationId: inv?.id ?? null,
      name: app.name,
      email,
      phone: app.phone,
      credentials: app.credentials,
      experience: app.experience,
      message: app.message,
      createdAt: app.createdAt,
      stage: s.stage,
      stageLabel: STAGE_LABELS[s.stage],
      stageUpdatedAt: s.at,
      details: s.details,
      conflictRole: conflictMap.get(email) ?? null,
    });
  }

  for (const inv of invitations) {
    const email = normalizeEmail(inv.email);
    if (activated.has(email) || seen.has(email)) continue;
    seen.add(email);
    const s = stageFor(inv, latestDocsLog.get(inv.id));
    items.push({
      id: inv.id,
      source: 'invitation',
      applicationId: null,
      invitationId: inv.id,
      name: `${inv.firstName} ${inv.lastName}`.trim(),
      email,
      phone: null,
      credentials: null,
      experience: null,
      message: null,
      createdAt: inv.createdAt,
      stage: s.stage,
      stageLabel: STAGE_LABELS[s.stage],
      stageUpdatedAt: s.at,
      details: s.details,
      conflictRole: conflictMap.get(email) ?? null,
    });
  }

  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return items;
}
