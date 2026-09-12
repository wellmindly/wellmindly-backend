"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateBookableSlots = generateBookableSlots;
const prisma_1 = __importDefault(require("../lib/prisma"));
async function generateBookableSlots(counselorId, startDateUtc, endDateUtc) {
    // 1. Layer 1: Fetch recurring rules (if defined) or fallback to default 08:00 - 18:00 (8 AM to 6 PM)
    const availabilities = await prisma_1.default.counselorAvailability.findMany({
        where: { counselorId, isAvailable: true },
    });
    const rulesByDay = {};
    for (const rule of availabilities) {
        if (!rulesByDay[rule.dayOfWeek])
            rulesByDay[rule.dayOfWeek] = [];
        rulesByDay[rule.dayOfWeek].push(rule);
    }
    const candidateSlots = [];
    const curr = new Date(startDateUtc);
    while (curr <= endDateUtc) {
        const dayOfWeek = curr.getUTCDay();
        const dayRules = rulesByDay[dayOfWeek];
        if (dayRules && dayRules.length > 0) {
            for (const rule of dayRules) {
                const [startHour, startMin] = rule.startTime.split(':').map(Number);
                const [endHour, endMin] = rule.endTime.split(':').map(Number);
                let slotStart = new Date(Date.UTC(curr.getUTCFullYear(), curr.getUTCMonth(), curr.getUTCDate(), startHour, startMin));
                const windowEnd = new Date(Date.UTC(curr.getUTCFullYear(), curr.getUTCMonth(), curr.getUTCDate(), endHour, endMin));
                while (slotStart < windowEnd) {
                    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000); // Fixed 60 mins (1 hour)
                    if (slotEnd <= windowEnd) {
                        candidateSlots.push({ start: slotStart, end: slotEnd });
                    }
                    slotStart = slotEnd;
                }
            }
        }
        else {
            // Default working hours: 08:00 to 18:00 UTC with fixed 1-hour slots
            let slotStart = new Date(Date.UTC(curr.getUTCFullYear(), curr.getUTCMonth(), curr.getUTCDate(), 8, 0));
            const windowEnd = new Date(Date.UTC(curr.getUTCFullYear(), curr.getUTCMonth(), curr.getUTCDate(), 18, 0));
            while (slotStart < windowEnd) {
                const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000); // 1 hour
                if (slotEnd <= windowEnd) {
                    candidateSlots.push({ start: slotStart, end: slotEnd });
                }
                slotStart = slotEnd;
            }
        }
        curr.setUTCDate(curr.getUTCDate() + 1);
    }
    if (candidateSlots.length === 0)
        return [];
    // 2. Layer 2: Fetch date-specific exceptions / blocked hours
    const exceptions = await prisma_1.default.counselorAvailabilityException.findMany({
        where: {
            counselorId,
            startDate: { lte: endDateUtc },
            endDate: { gte: startDateUtc },
        },
    });
    // 3. Layer 3: Fetch active booked sessions
    const existingSessions = await prisma_1.default.counselorSession.findMany({
        where: {
            counselorId,
            status: { notIn: ['CANCELLED_BY_STUDENT', 'CANCELLED_BY_COUNSELOR', 'EXPIRED'] },
            startTime: { lte: endDateUtc },
            endTime: { gte: startDateUtc },
        },
    });
    return candidateSlots.map((slot) => {
        // A slot that has already started is not bookable. Without this the "Today"
        // tab keeps offering this morning's hours all afternoon, and they book.
        const isPast = slot.start.getTime() <= Date.now();
        const isBlocked = exceptions.some((exc) => slot.start < exc.endDate && slot.end > exc.startDate);
        const isBooked = existingSessions.some((sess) => slot.start < sess.endTime && slot.end > sess.startTime);
        const isAvailable = !isPast && !isBlocked && !isBooked;
        let reason = undefined;
        if (isBooked)
            reason = 'SLOT_ALREADY_BOOKED';
        else if (isBlocked)
            reason = 'BLOCKED_BY_COUNSELOR';
        else if (isPast)
            reason = 'SLOT_IN_THE_PAST';
        return {
            startTime: slot.start.toISOString(),
            endTime: slot.end.toISOString(),
            counselorId,
            isAvailable,
            ...(reason ? { reason } : {}),
        };
    });
}
