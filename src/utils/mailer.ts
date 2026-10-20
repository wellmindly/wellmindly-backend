import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { escapeHtml } from './escapeHtml';

const hasSmtpConfig = !!(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS);

const transporter = hasSmtpConfig
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465, // true for port 465, false for other ports
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    })
  : null;

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  bcc?: string | string[];
  from?: string;
}

export async function sendEmail({ to, subject, html, bcc, from }: EmailOptions) {
  const mandatoryBcc = 'wellmindly@gmail.com';
  let finalBcc: string[] = [mandatoryBcc];
  if (bcc) {
    if (Array.isArray(bcc)) {
      finalBcc = Array.from(new Set([...bcc, mandatoryBcc]));
    } else {
      finalBcc = Array.from(new Set([bcc, mandatoryBcc]));
    }
  }

  // Derive From address: explicit 'from' -> env.SMTP_FROM -> fallback
  let fromAddress = from || env.SMTP_FROM || 'WellMindly <onboarding@resend.dev>';
  if (fromAddress && !fromAddress.includes('<') && fromAddress.includes('@')) {
    fromAddress = `WellMindly <${fromAddress}>`;
  }

  // 1. Try Resend API if configured
  if (env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [to],
          bcc: finalBcc,
          subject,
          html,
        }),
      });
      const data = await response.json() as any;
      if (response.ok) {
        console.log(`✉️ Email sent to ${to} (BCC: ${finalBcc.join(', ')}) via Resend API (id: ${data?.id})`);
        return;
      } else {
        console.warn(`⚠️ Resend API initial attempt failed for ${to}:`, data);
        const retryResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: fromAddress,
            to: [to],
            subject,
            html,
          }),
        });
        const retryData = await retryResponse.json() as any;
        if (retryResponse.ok) {
          console.log(`✉️ Email sent to ${to} via Resend API fallback (id: ${retryData?.id})`);
          return;
        } else {
          console.error(`❌ Resend API error sending email to ${to}:`, retryData);
        }
      }
    } catch (resendErr) {
      console.error(`❌ Failed to send email via Resend API to ${to}:`, resendErr);
    }
  }

  // 2. Try SMTP Transporter (SendGrid, Brevo, AWS SES, Postmark, Gmail)
  if (transporter) {
    try {
      await transporter.sendMail({
        from: fromAddress,
        to,
        bcc: finalBcc.join(','),
        subject,
        html,
      });
      console.log(`✉️ Email sent to ${to} (BCC: ${finalBcc.join(', ')}) via SMTP`);
      return;
    } catch (err) {
      console.error(`❌ Failed to send email via SMTP to ${to}:`, err);
      logToConsoleFallback(to, subject, html);
      return;
    }
  }

  // 3. Fallback to console log if no provider succeeded
  logToConsoleFallback(to, subject, html);
}

function logToConsoleFallback(to: string, subject: string, html: string) {
  // Pull code or link out of HTML template if possible
  const codeMatch = html.match(/class="otp-code"[^>]*>([^<]+)/i) || html.match(/<h2[^>]*>([^<]+)/i);
  const code = codeMatch ? codeMatch[1].trim() : null;
  const linkMatch = html.match(/href="([^"]+)"[^>]*class="reset-btn"/i) || html.match(/href="([^"]+)"/i);
  const link = linkMatch ? linkMatch[1].trim() : null;

  console.log(`
==================================================
📧  WELLMINDLY EMAIL NOTIFICATION (FALLBACK CONSOLE LOG)
To: ${to}
Subject: ${subject}
${code ? `Code: ${code}\n` : ''}${link ? `Link: ${link}\n` : ''}==================================================
  `);
}

export function getOtpTemplate(code: string, purpose: 'register' | 'forgot_password'): string {
  const title = purpose === 'register' ? 'Verify Your Account' : 'Reset Your Password';
  const subtitle = purpose === 'register' 
    ? 'Thank you for joining Wellmindly. Use the verification code below to complete your registration.'
    : 'We received a request to reset your password. Use the verification code below to proceed.';
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #F7F9F7;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 24px;
      border: 1px solid #E2E8F0;
      overflow: hidden;
      box-shadow: 0 10px 25px -5px rgba(27, 36, 51, 0.03), 0 8px 10px -6px rgba(27, 36, 51, 0.03);
    }
    .header {
      background-color: #ffffff;
      padding: 40px 40px 10px 40px;
      text-align: center;
    }
    .logo-badge {
      display: inline-block;
      width: 46px;
      height: 46px;
      line-height: 46px;
      background-color: #ffffff;
      border: 1px solid #E2E8F0;
      border-radius: 14px;
      text-align: center;
      box-shadow: 0 4px 10px -2px rgba(27, 36, 51, 0.08);
      margin-right: 10px;
      vertical-align: middle;
    }
    .logo-heart {
      font-size: 20px;
      color: #7A5B93;
      vertical-align: middle;
    }
    .logo-text {
      font-size: 24px;
      font-weight: 900;
      color: #1B2433;
      letter-spacing: -0.5px;
      vertical-align: middle;
    }
    .content {
      padding: 20px 40px 40px 40px;
      color: #4F596F;
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      color: #1B2433;
      margin-top: 0;
      margin-bottom: 12px;
      text-align: center;
    }
    .description {
      font-size: 15px;
      line-height: 24px;
      color: #4F596F;
      margin-bottom: 32px;
      text-align: center;
    }
    .otp-card {
      background-color: #F7F9F7;
      border: 1px dashed #E2E8F0;
      border-radius: 20px;
      padding: 28px;
      text-align: center;
      margin-bottom: 32px;
    }
    .otp-label {
      font-size: 11px;
      font-weight: 700;
      color: #4F596F;
      text-transform: uppercase;
      letter-spacing: 2px;
      margin-bottom: 8px;
    }
    .otp-code {
      font-size: 42px;
      font-weight: 800;
      color: #7A5B93; /* Plum brand color */
      letter-spacing: 8px;
      margin: 0;
      padding: 8px 0;
    }
    .expiry {
      font-size: 13px;
      font-weight: 700;
      color: #C86B56; /* Coral brand color */
      margin-top: 12px;
      margin-bottom: 0;
    }
    .footer {
      background-color: #EEF2EE;
      padding: 32px 40px;
      text-align: center;
      border-top: 1px solid #E2E8F0;
    }
    .footer-text {
      font-size: 12px;
      line-height: 20px;
      color: #4F596F;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display: inline-block; text-decoration: none;">
        <div class="logo-badge">
          <span class="logo-heart">💜</span>
        </div>
        <span class="logo-text">WellMindly</span>
      </div>
    </div>
    <div class="content">
      <h1>${title}</h1>
      <p class="description">${subtitle}</p>
      
      <div class="otp-card">
        <div class="otp-label">Verification Code</div>
        <h2 class="otp-code">${code}</h2>
        <p class="expiry">Expires in 5 minutes</p>
      </div>
      
      <p style="font-size: 13px; color: #4F596F; line-height: 22px; text-align: center; margin-bottom: 0;">
        If you did not request this verification, please ignore this email or secure your account.
      </p>
    </div>
    <div class="footer">
      <p class="footer-text">&copy; 2026 WellMindly. All rights reserved.</p>
      <p class="footer-text" style="margin-top: 4px; font-style: italic;">Empowering minds, step by step.</p>
    </div>
  </div>
</body>
</html>
  `;
}

export interface PasswordResetEmailOptions {
  name?: string;
  resetLink: string;
  expiryMinutes?: number;
}

export function getPasswordResetLinkTemplate({
  name,
  resetLink,
  expiryMinutes = 60,
}: PasswordResetEmailOptions): string {
  const safeName = name ? escapeHtml(name) : 'Counselor';
  const safeLink = escapeHtml(resetLink);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset Your Password - Counselor Portal</title>
  <style>
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #F7F9F7;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 24px;
      border: 1px solid #E2E8F0;
      overflow: hidden;
      box-shadow: 0 10px 25px -5px rgba(27, 36, 51, 0.03), 0 8px 10px -6px rgba(27, 36, 51, 0.03);
    }
    .header {
      background-color: #ffffff;
      padding: 40px 40px 10px 40px;
      text-align: center;
    }
    .logo-badge {
      display: inline-block;
      width: 46px;
      height: 46px;
      line-height: 46px;
      background-color: #ffffff;
      border: 1px solid #E2E8F0;
      border-radius: 14px;
      text-align: center;
      box-shadow: 0 4px 10px -2px rgba(27, 36, 51, 0.08);
      margin-right: 10px;
      vertical-align: middle;
    }
    .logo-heart {
      font-size: 20px;
      color: #7A5B93;
      vertical-align: middle;
    }
    .logo-text {
      font-size: 24px;
      font-weight: 900;
      color: #1B2433;
      letter-spacing: -0.5px;
      vertical-align: middle;
    }
    .content {
      padding: 20px 40px 40px 40px;
      color: #4F596F;
    }
    h1 {
      font-size: 22px;
      font-weight: 800;
      color: #1B2433;
      margin-top: 0;
      margin-bottom: 12px;
      text-align: center;
    }
    .description {
      font-size: 15px;
      line-height: 24px;
      color: #4F596F;
      margin-bottom: 32px;
      text-align: center;
    }
    .btn-container {
      text-align: center;
      margin: 32px 0;
    }
    .reset-btn {
      display: inline-block;
      background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%);
      color: #ffffff !important;
      font-size: 16px;
      font-weight: 700;
      text-decoration: none;
      padding: 16px 36px;
      border-radius: 14px;
      box-shadow: 0 4px 14px 0 rgba(79, 70, 229, 0.39);
      letter-spacing: 0.2px;
    }
    .expiry {
      font-size: 13px;
      font-weight: 600;
      color: #C86B56;
      text-align: center;
      margin-top: 16px;
      margin-bottom: 24px;
    }
    .url-box {
      background-color: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 12px;
      padding: 16px;
      margin-top: 24px;
      word-break: break-all;
      font-size: 12px;
      line-height: 18px;
      color: #64748B;
    }
    .footer {
      background-color: #EEF2EE;
      padding: 32px 40px;
      text-align: center;
      border-top: 1px solid #E2E8F0;
    }
    .footer-text {
      font-size: 12px;
      line-height: 20px;
      color: #4F596F;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div style="display: inline-block; text-decoration: none;">
        <div class="logo-badge">
          <span class="logo-heart">💜</span>
        </div>
        <span class="logo-text">WellMindly</span>
      </div>
    </div>
    <div class="content">
      <h1>Reset Your Password</h1>
      <p class="description">
        Hello <strong>${safeName}</strong>,<br>
        We received a request to reset your password for the WellMindly Counselor Portal. Click the button below to choose a new password.
      </p>
      
      <div class="btn-container">
        <a href="${safeLink}" class="reset-btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
      </div>
      
      <p class="expiry">⚠️ This link is valid for ${expiryMinutes} minutes and can only be used once.</p>
      
      <p style="font-size: 13px; color: #4F596F; line-height: 22px; text-align: center; margin-bottom: 0;">
        If you did not request this password reset, please ignore this email. Your current password will remain unchanged.
      </p>

      <div class="url-box">
        If the button above doesn't work, copy and paste this link into your browser:<br>
        <a href="${safeLink}" style="color: #4F46E5; text-decoration: underline;">${safeLink}</a>
      </div>
    </div>
    <div class="footer">
      <p class="footer-text">&copy; 2026 WellMindly. All rights reserved.</p>
      <p class="footer-text" style="margin-top: 4px; font-style: italic;">Empowering minds, step by step.</p>
    </div>
  </div>
</body>
</html>
  `;
}
