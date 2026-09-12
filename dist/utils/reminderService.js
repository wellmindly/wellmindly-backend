"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startReminderScheduler = startReminderScheduler;
const prisma_1 = __importDefault(require("../lib/prisma"));
const emailQueue_1 = require("./emailQueue");
const escapeHtml_1 = require("./escapeHtml");
function startReminderScheduler() {
    // Check reminders every 5 minutes
    setInterval(async () => {
        try {
            await checkAndSendReminders();
        }
        catch (err) {
            console.error('[ReminderScheduler Error]:', err);
        }
    }, 5 * 60 * 1000);
}
async function checkAndSendReminders() {
    const now = new Date();
    // Find upcoming confirmed sessions within the next 24 hours that haven't been reminded
    const upcomingSessions = await prisma_1.default.counselorSession.findMany({
        where: {
            status: 'CONFIRMED',
            startTime: {
                gte: now,
                lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
            },
        },
        include: {
            student: true,
            counselor: {
                include: {
                    user: true,
                },
            },
        },
    });
    for (const session of upcomingSessions) {
        const diffMins = Math.floor((session.startTime.getTime() - now.getTime()) / (1000 * 60));
        // Send 24h reminder (between 23h 50m and 24h)
        if (diffMins >= 1430 && diffMins <= 1440) {
            sendSessionReminder(session, '24 hours');
        }
        // Send 1h reminder (between 55m and 60m)
        else if (diffMins >= 55 && diffMins <= 60) {
            sendSessionReminder(session, '1 hour');
        }
        // Send 10m reminder (between 8m and 12m)
        else if (diffMins >= 8 && diffMins <= 12) {
            sendSessionReminder(session, '10 minutes');
        }
    }
}
function sendSessionReminder(session, windowText) {
    const studentEmail = session.student.email;
    const counselorEmail = session.counselor.user.email;
    const meetingLink = session.meetingLink;
    // 1. Notify Student
    (0, emailQueue_1.queueEmail)({
        to: studentEmail,
        subject: `Reminder: Counseling session in ${windowText}`,
        html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
        <h2 style="color: #4f46e5;">Upcoming Counseling Session</h2>
        <p>Hello <strong>${(0, escapeHtml_1.escapeHtml)(session.student.firstName)}</strong>,</p>
        <p>Your session with <strong>${(0, escapeHtml_1.escapeHtml)(session.counselor.user.firstName)} ${(0, escapeHtml_1.escapeHtml)(session.counselor.user.lastName)}</strong> starts in <strong>${windowText}</strong>.</p>
        <p style="margin: 20px 0;">
          <a href="${meetingLink}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Join Video Call</a>
        </p>
        <p>Meeting URL: <a href="${meetingLink}">${meetingLink}</a></p>
      </div>
    `,
    });
    // 2. Notify Counselor
    (0, emailQueue_1.queueEmail)({
        to: counselorEmail,
        subject: `Reminder: Session with ${session.student.firstName} in ${windowText}`,
        html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
        <h2 style="color: #4f46e5;">Upcoming Student Session</h2>
        <p>Hello <strong>${(0, escapeHtml_1.escapeHtml)(session.counselor.user.firstName)}</strong>,</p>
        <p>Your counseling session with <strong>${(0, escapeHtml_1.escapeHtml)(session.student.firstName)} ${(0, escapeHtml_1.escapeHtml)(session.student.lastName)}</strong> starts in <strong>${windowText}</strong>.</p>
        <p style="margin: 20px 0;">
          <a href="${meetingLink}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Launch Meeting Room</a>
        </p>
      </div>
    `,
    });
    // 3. Create In-App Notification record for student
    prisma_1.default.notification
        .create({
        data: {
            userId: session.student.id,
            title: `Session Starting in ${windowText}`,
            message: `Your counseling session with ${session.counselor.user.firstName} starts soon. Click to join video call.`,
            type: 'SESSION_REMINDER',
        },
    })
        .catch((err) => console.error('[Notification Error]:', err));
}
