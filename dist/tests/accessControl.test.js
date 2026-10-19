"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const accessControl_1 = require("../services/accessControl");
(0, vitest_1.describe)('Access Control Service', () => {
    (0, vitest_1.it)('normalizes domains properly', () => {
        (0, vitest_1.expect)((0, accessControl_1.normalizeDomain)('@ves.ac.in')).toBe('ves.ac.in');
        (0, vitest_1.expect)((0, accessControl_1.normalizeDomain)('  @VES.AC.IN  ')).toBe('ves.ac.in');
        (0, vitest_1.expect)((0, accessControl_1.normalizeDomain)('https://harvard.edu/test')).toBe('harvard.edu');
        (0, vitest_1.expect)((0, accessControl_1.normalizeDomain)('mit.edu/')).toBe('mit.edu');
    });
    (0, vitest_1.it)('normalizes emails properly', () => {
        (0, vitest_1.expect)((0, accessControl_1.normalizeEmail)('  JMalani54@Gmail.Com  ')).toBe('jmalani54@gmail.com');
    });
    (0, vitest_1.it)('recognizes pre-seeded bypass email jmalani54@gmail.com', async () => {
        const result = await (0, accessControl_1.isStudentEligible)('jmalani54@gmail.com');
        (0, vitest_1.expect)(result.eligible).toBe(true);
        (0, vitest_1.expect)(result.reason).toBe('BYPASS_EMAIL');
    });
    (0, vitest_1.it)('recognizes pre-seeded university domain ves.ac.in', async () => {
        const result = await (0, accessControl_1.isStudentEligible)('student123@ves.ac.in');
        (0, vitest_1.expect)(result.eligible).toBe(true);
        (0, vitest_1.expect)(result.reason).toBe('UNIVERSITY_DOMAIN');
        (0, vitest_1.expect)(result.domain).toBe('ves.ac.in');
    });
    (0, vitest_1.it)('recognizes subdomain of allowed university domain', async () => {
        const result = await (0, accessControl_1.isStudentEligible)('alice@engg.ves.ac.in');
        (0, vitest_1.expect)(result.eligible).toBe(true);
        (0, vitest_1.expect)(result.reason).toBe('UNIVERSITY_DOMAIN');
    });
    (0, vitest_1.it)('rejects non-whitelisted email domains', async () => {
        const result = await (0, accessControl_1.isStudentEligible)('unauthorized@gmail.com');
        (0, vitest_1.expect)(result.eligible).toBe(false);
        (0, vitest_1.expect)(result.reason).toBe('NOT_ELIGIBLE');
    });
    (0, vitest_1.it)('can dynamically add and delete allowed domains', async () => {
        const added = await (0, accessControl_1.addAllowedDomain)('@stanford.edu', 'Stanford University');
        (0, vitest_1.expect)(added.domain).toBe('stanford.edu');
        const checkBefore = await (0, accessControl_1.isStudentEligible)('john@stanford.edu');
        (0, vitest_1.expect)(checkBefore.eligible).toBe(true);
        (0, vitest_1.expect)(checkBefore.reason).toBe('UNIVERSITY_DOMAIN');
        await (0, accessControl_1.deleteAllowedDomain)(added.id);
        const checkAfter = await (0, accessControl_1.isStudentEligible)('john@stanford.edu');
        (0, vitest_1.expect)(checkAfter.eligible).toBe(false);
    });
    (0, vitest_1.it)('can dynamically add and delete bypass emails', async () => {
        const added = await (0, accessControl_1.addBypassEmail)('testvip@outlook.com', 'VIP User');
        (0, vitest_1.expect)(added.email).toBe('testvip@outlook.com');
        const checkBefore = await (0, accessControl_1.isStudentEligible)('testvip@outlook.com');
        (0, vitest_1.expect)(checkBefore.eligible).toBe(true);
        (0, vitest_1.expect)(checkBefore.reason).toBe('BYPASS_EMAIL');
        await (0, accessControl_1.deleteBypassEmail)(added.id);
        const checkAfter = await (0, accessControl_1.isStudentEligible)('testvip@outlook.com');
        (0, vitest_1.expect)(checkAfter.eligible).toBe(false);
    });
});
