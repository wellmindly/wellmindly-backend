import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { authenticateJWT, authorizeRoles } from '../utils/jwt';
import { sendEmail } from '../utils/mailer';
import { queueEmail } from '../utils/emailQueue';
import { escapeHtml } from '../utils/escapeHtml';
import { env } from '../config/env';

const router = Router();

const generalContactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  subject: z.string().optional(),
  message: z.string().min(1, 'Message is required'),
});

const universityContactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  universityName: z.string().min(1, 'University name is required'),
  role: z.string().min(1, 'Role is required'),
  phone: z.string().optional(),
  message: z.string().min(1, 'Message is required'),
});

const counselorContactSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  phone: z.string().optional(),
  credentials: z.string().min(1, 'Credentials are required'),
  experience: z.string().min(1, 'Experience detail is required'),
  message: z.string().min(1, 'Message is required'),
});

// --- Public Endpoints ---

router.post('/general', async (req: Request, res: Response) => {
  try {
    const data = generalContactSchema.parse(req.body);
    const request = await prisma.contactRequest.create({ data });

    // (a) Submitter acknowledgement
    queueEmail({
      to: data.email,
      subject: `We've received your message: ${data.subject || 'General Inquiry'}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">Message Received</h2>
          <p>Hello <strong>${escapeHtml(data.name)}</strong>,</p>
          <p>Thank you for reaching out to WellMindly. We have received your message regarding <strong>${escapeHtml(data.subject || 'General Inquiry')}</strong> and a member of our team will review it.</p>
          <p style="color: #64748b; font-size: 14px; margin-top: 20px;">WellMindly Student Support Team</p>
        </div>
      `,
    });

    // (b) Internal notification
    queueEmail({
      to: env.CONTACT_NOTIFY_TO,
      subject: `[Contact Request] ${data.subject || 'General Inquiry'} from ${data.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">New Contact Request</h2>
          <p><strong>From:</strong> ${escapeHtml(data.name)} (${escapeHtml(data.email)})</p>
          <p><strong>Subject:</strong> ${escapeHtml(data.subject || 'N/A')}</p>
          <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 16px 0;">
            <p style="white-space: pre-wrap; margin: 0;">${escapeHtml(data.message)}</p>
          </div>
        </div>
      `,
    });

    res.status(201).json({ success: true, message: 'Message received', data: request });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0].message });
      return;
    }
    console.error('Error creating general contact:', error);
    res.status(500).json({ error: 'Failed to submit contact request' });
  }
});

router.post('/university', async (req: Request, res: Response) => {
  try {
    const data = universityContactSchema.parse(req.body);
    const request = await prisma.universityOnboarding.create({ data });

    // (a) Submitter acknowledgement
    queueEmail({
      to: data.email,
      subject: `University Partnership Inquiry: ${data.universityName}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">University Onboarding Request Received</h2>
          <p>Hello <strong>${escapeHtml(data.name)}</strong>,</p>
          <p>Thank you for your interest in bringing WellMindly to <strong>${escapeHtml(data.universityName)}</strong>. Our partnerships team has received your request and will review your institution's details.</p>
          <p style="color: #64748b; font-size: 14px; margin-top: 20px;">WellMindly University Partnerships</p>
        </div>
      `,
    });

    // (b) Internal notification
    queueEmail({
      to: env.CONTACT_NOTIFY_TO,
      subject: `[University Partnership] ${data.universityName} from ${data.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">New University Onboarding Request</h2>
          <p><strong>Contact:</strong> ${escapeHtml(data.name)} (${escapeHtml(data.email)})</p>
          <p><strong>University:</strong> ${escapeHtml(data.universityName)}</p>
          <p><strong>Role:</strong> ${escapeHtml(data.role)}</p>
          <p><strong>Phone:</strong> ${escapeHtml(data.phone || 'N/A')}</p>
          <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 16px 0;">
            <p style="white-space: pre-wrap; margin: 0;">${escapeHtml(data.message)}</p>
          </div>
        </div>
      `,
    });

    res.status(201).json({ success: true, message: 'University onboarding request received', data: request });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0].message });
      return;
    }
    console.error('Error creating university contact:', error);
    res.status(500).json({ error: 'Failed to submit university onboarding request' });
  }
});

router.post('/counselor', async (req: Request, res: Response) => {
  try {
    const data = counselorContactSchema.parse(req.body);
    const request = await prisma.counselorOnboarding.create({ data });

    // (a) Submitter acknowledgement
    queueEmail({
      to: data.email,
      subject: `Counselor Application Received: ${data.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">Counselor Application Received</h2>
          <p>Hello <strong>${escapeHtml(data.name)}</strong>,</p>
          <p>Thank you for applying to join the WellMindly counselor network. We have received your application with credentials (<strong>${escapeHtml(data.credentials)}</strong>) and our clinical review team will assess your submission.</p>
          <p style="color: #64748b; font-size: 14px; margin-top: 20px;">WellMindly Clinical Operations</p>
        </div>
      `,
    });

    // (b) Internal notification
    queueEmail({
      to: env.CONTACT_NOTIFY_TO,
      subject: `[Counselor Application] ${data.name} (${data.credentials})`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <h2 style="color: #4f46e5;">New Counselor Application</h2>
          <p><strong>Applicant:</strong> ${escapeHtml(data.name)} (${escapeHtml(data.email)})</p>
          <p><strong>Phone:</strong> ${escapeHtml(data.phone || 'N/A')}</p>
          <p><strong>Credentials:</strong> ${escapeHtml(data.credentials)}</p>
          <div style="background-color: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #4f46e5; margin: 16px 0;">
            <p><strong>Experience:</strong></p>
            <p style="white-space: pre-wrap; margin: 0 0 12px 0;">${escapeHtml(data.experience)}</p>
            <p><strong>Message / Statement:</strong></p>
            <p style="white-space: pre-wrap; margin: 0;">${escapeHtml(data.message)}</p>
          </div>
        </div>
      `,
    });

    res.status(201).json({ success: true, message: 'Counselor application submitted successfully', data: request });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues[0].message });
      return;
    }
    console.error('Error creating counselor contact:', error);
    res.status(500).json({ error: 'Failed to submit counselor onboarding request' });
  }
});

router.get('/coaches', async (_req: Request, res: Response) => {
  try {
    const counselors = await prisma.counselorProfile.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      include: {
        user: {
          select: { firstName: true, lastName: true, email: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const formatted = counselors.map((c) => {
      const name = `${c.user.firstName} ${c.user.lastName}`;
      const init = `${c.user.firstName?.[0] || ''}${c.user.lastName?.[0] || ''}`.toUpperCase() || 'WC';

      return {
        id: c.id,
        name,
        firstName: c.user.firstName,
        lastName: c.user.lastName,
        role: c.credentials ? `${c.credentials.split(',')[0]}` : 'Wellbeing Coach',
        credentials: c.credentials,
        specializations: c.specializations,
        specs: c.specializations.slice(0, 3),
        bio: c.bio,
        avatarUrl: c.avatarUrl,
        init,
      };
    });

    res.status(200).json({ success: true, coaches: formatted });
  } catch (error) {
    console.error('Error fetching public coaches:', error);
    res.status(500).json({ error: 'Failed to fetch coaches' });
  }
});

// --- Admin Endpoints (Auth required + ADMIN role) ---

router.get(
  '/general',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const [contacts, total] = await Promise.all([
        prisma.contactRequest.findMany({
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.contactRequest.count(),
      ]);

      res.status(200).json({ contacts, total, page, limit });
    } catch (error) {
      console.error('Error fetching general contacts:', error);
      res.status(500).json({ error: 'Failed to fetch general contacts' });
    }
  }
);

router.get(
  '/university',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const [requests, total] = await Promise.all([
        prisma.universityOnboarding.findMany({
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.universityOnboarding.count(),
      ]);

      res.status(200).json({ requests, total, page, limit });
    } catch (error) {
      console.error('Error fetching university contacts:', error);
      res.status(500).json({ error: 'Failed to fetch university requests' });
    }
  }
);

router.get(
  '/counselor',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const [requests, total] = await Promise.all([
        prisma.counselorOnboarding.findMany({
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        prisma.counselorOnboarding.count(),
      ]);

      res.status(200).json({ requests, total, page, limit });
    } catch (error) {
      console.error('Error fetching counselor contacts:', error);
      res.status(500).json({ error: 'Failed to fetch counselor applications' });
    }
  }
);

router.delete(
  '/general/:id',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      await prisma.contactRequest.delete({ where: { id } });
      res.status(200).json({ success: true, message: 'Contact request deleted' });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') {
        res.status(404).json({ error: 'Contact request not found' });
        return;
      }
      console.error('Error deleting contact request:', error);
      res.status(500).json({ error: 'Failed to delete contact request' });
    }
  }
);

router.delete(
  '/university/:id',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      await prisma.universityOnboarding.delete({ where: { id } });
      res.status(200).json({ success: true, message: 'University request deleted' });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') {
        res.status(404).json({ error: 'University request not found' });
        return;
      }
      console.error('Error deleting university request:', error);
      res.status(500).json({ error: 'Failed to delete university onboarding request' });
    }
  }
);

router.delete(
  '/counselor/:id',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      await prisma.counselorOnboarding.delete({ where: { id } });
      res.status(200).json({ success: true, message: 'Counselor request deleted' });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') {
        res.status(404).json({ error: 'Counselor request not found' });
        return;
      }
      console.error('Error deleting counselor request:', error);
      res.status(500).json({ error: 'Failed to delete counselor onboarding request' });
    }
  }
);

router.post(
  '/counselor/:id/request-docs',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const application = await prisma.counselorOnboarding.findUnique({ where: { id } });

      if (!application) {
        res.status(404).json({ error: 'Counselor application not found' });
        return;
      }

      const emailSubject = 'Document & Certificate Verification Request - WellMindly Counselor Application';
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
          <h2 style="color: #4f46e5; margin-top: 0;">WellMindly Counselor Application Verification</h2>
          <p>Hello <strong>${application.name}</strong>,</p>
          <p>Thank you for submitting your counselor onboarding application to WellMindly. We are reviewing your application credentials (<em>${application.credentials}</em>).</p>
          <p>To proceed with your application review and onboard you to our counselor network, please reply to this email with the following documents attached:</p>
          <ul style="padding-left: 20px; color: #334155;">
            <li><strong>Degree & Professional Certificates</strong> (M.A., Ph.D., RBT, or clinical certifications)</li>
            <li><strong>Government-issued Identity Document</strong> (Passport or ID)</li>
            <li><strong>Proof of Professional License / Practice Standing</strong></li>
            <li>Any additional background documentation or reference letters</li>
          </ul>
          <p>If you have any questions, feel free to reply directly to this message or contact our team at <a href="mailto:wellmindly@gmail.com" style="color: #4f46e5;">wellmindly@gmail.com</a>.</p>
          <p style="margin-top: 24px; color: #64748b; font-size: 13px;">Warm regards,<br /><strong>The WellMindly Clinical Operations Team</strong></p>
        </div>
      `;

      await sendEmail({
        to: application.email,
        subject: emailSubject,
        html: emailHtml,
      });

      res.status(200).json({
        success: true,
        message: `Document & certificate request email sent to ${application.email}`,
      });
    } catch (error) {
      console.error('Error requesting counselor documents:', error);
      res.status(500).json({ error: 'Failed to send document request email' });
    }
  }
);

router.post(
  '/counselor/:id/approve-onboard',
  authenticateJWT,
  authorizeRoles('ADMIN'),
  async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const application = await prisma.counselorOnboarding.findUnique({ where: { id } });

      if (!application) {
        res.status(404).json({ error: 'Counselor application not found' });
        return;
      }

      const nameParts = application.name.trim().split(' ');
      const firstName = nameParts[0] || application.name;
      const lastName = nameParts.slice(1).join(' ') || 'Counselor';
      const cleanEmail = application.email.trim().toLowerCase();

      let user = await prisma.user.findUnique({ where: { email: cleanEmail } });

      if (!user) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const invitation = await prisma.counselorInvitation.upsert({
          where: { email: cleanEmail },
          update: { firstName, lastName, token, expiresAt, used: false },
          create: { email: cleanEmail, firstName, lastName, token, expiresAt },
        });

        const counselorPortalBase = env.COUNSELOR_PORTAL_URL || (process.env.NODE_ENV === 'production' ? 'https://counselor.wellmindly.com' : 'http://localhost:5174');
        const setupUrl = `${counselorPortalBase}/setup-profile?token=${token}`;

        await sendEmail({
          to: cleanEmail,
          subject: 'Congratulations! Your WellMindly Counselor Application is Approved',
          html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
              <h2 style="color: #4f46e5; margin-top: 0;">Application Approved & Onboarding Invitation</h2>
              <p>Hello <strong>${firstName} ${lastName}</strong>,</p>
              <p>We are delighted to inform you that your counselor onboarding application (<em>${application.credentials}</em>) has been <strong>approved</strong> by the WellMindly team!</p>
              <p>Please click the button below to complete your registration, set up your account password, and configure your counselor profile & availability slots:</p>
              <p style="margin: 28px 0;">
                <a href="${setupUrl}" style="background-color: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);">Set Up Counselor Profile</a>
              </p>
              <p style="color: #64748b; font-size: 13px;">Direct Link: <a href="${setupUrl}" style="color: #4f46e5;">${setupUrl}</a></p>
              <p style="color: #94a3b8; font-size: 12px; margin-top: 24px;">This invitation link will remain valid for 7 days.</p>
            </div>
          `,
        });

        res.status(200).json({
          success: true,
          message: `Counselor application approved! Onboarding invitation emailed to ${cleanEmail}`,
          setupUrl,
          invitation,
        });
      } else {
        if (user.role !== 'COUNSELOR') {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { role: 'COUNSELOR' },
          });
        }

        const existingProfile = await prisma.counselorProfile.findUnique({ where: { userId: user.id } });
        if (!existingProfile) {
          await prisma.counselorProfile.create({
            data: {
              userId: user.id,
              credentials: application.credentials,
              specializations: ['Youth Wellbeing', 'Mentorship'],
              bio: application.experience || application.message,
              phone: application.phone,
              status: 'ACTIVE',
            },
          });
        }

        res.status(200).json({
          success: true,
          message: `Counselor application approved! Account for ${cleanEmail} activated as Counselor.`,
        });
      }
    } catch (error) {
      console.error('Error approving counselor application:', error);
      res.status(500).json({ error: 'Failed to approve counselor application' });
    }
  }
);

export default router;
