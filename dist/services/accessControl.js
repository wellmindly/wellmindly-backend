"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDomain = normalizeDomain;
exports.normalizeEmail = normalizeEmail;
exports.ensureDatabaseTables = ensureDatabaseTables;
exports.getAllowedDomains = getAllowedDomains;
exports.getBypassEmails = getBypassEmails;
exports.addAllowedDomain = addAllowedDomain;
exports.deleteAllowedDomain = deleteAllowedDomain;
exports.addBypassEmail = addBypassEmail;
exports.deleteBypassEmail = deleteBypassEmail;
exports.isStudentEligible = isStudentEligible;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const prisma_1 = __importDefault(require("../lib/prisma"));
const DATA_FILE_PATH = path_1.default.resolve(__dirname, '../../data/access-control.json');
const BACKUP_FILE_PATH = path_1.default.resolve(__dirname, '../../data/access-control.backup.json');
/**
 * Normalizes a domain string:
 * - strips whitespace and converts to lower case
 * - strips leading '@' (e.g., '@ves.ac.in' -> 'ves.ac.in')
 * - strips protocol (http:// or https://) if pasted by user
 * - strips trailing paths or slashes
 */
function normalizeDomain(rawDomain) {
    if (!rawDomain)
        return '';
    let cleaned = rawDomain.trim().toLowerCase();
    cleaned = cleaned.replace(/^https?:\/\//, '');
    cleaned = cleaned.replace(/^\/+/, '');
    cleaned = cleaned.split('/')[0];
    cleaned = cleaned.replace(/^@+/, '');
    return cleaned.trim();
}
/**
 * Normalizes an email address:
 * - strips whitespace and converts to lower case
 */
function normalizeEmail(rawEmail) {
    if (!rawEmail)
        return '';
    return rawEmail.trim().toLowerCase();
}
/**
 * Read data from local JSON storage with safe fallback and backup merge.
 */
function readLocalData() {
    const defaultInitial = {
        domains: [
            {
                id: 'dom_ves_ac_in',
                domain: 'ves.ac.in',
                name: 'VES College (VESIT / VES)',
                createdAt: '2026-10-20T00:00:00.000Z',
            },
        ],
        bypassEmails: [
            {
                id: 'byp_jmalani54',
                email: 'jmalani54@gmail.com',
                note: 'Admin Test / VIP Bypass Access',
                createdAt: '2026-10-20T00:00:00.000Z',
            },
        ],
    };
    let primary = { domains: [], bypassEmails: [] };
    let hasPrimary = false;
    try {
        if (fs_1.default.existsSync(DATA_FILE_PATH)) {
            const raw = fs_1.default.readFileSync(DATA_FILE_PATH, 'utf-8');
            const parsed = JSON.parse(raw);
            primary = {
                domains: Array.isArray(parsed.domains) ? parsed.domains : [],
                bypassEmails: Array.isArray(parsed.bypassEmails) ? parsed.bypassEmails : [],
            };
            hasPrimary = true;
        }
    }
    catch (err) {
        console.warn('[AccessControl] Failed reading DATA_FILE_PATH:', err);
    }
    // Check backup file to ensure no data is ever lost across resets
    let backup = { domains: [], bypassEmails: [] };
    try {
        if (fs_1.default.existsSync(BACKUP_FILE_PATH)) {
            const rawBackup = fs_1.default.readFileSync(BACKUP_FILE_PATH, 'utf-8');
            const parsedBackup = JSON.parse(rawBackup);
            backup = {
                domains: Array.isArray(parsedBackup.domains) ? parsedBackup.domains : [],
                bypassEmails: Array.isArray(parsedBackup.bypassEmails) ? parsedBackup.bypassEmails : [],
            };
        }
    }
    catch (err) {
        console.warn('[AccessControl] Failed reading BACKUP_FILE_PATH:', err);
    }
    // Merge primary and backup by unique domain / email
    const domainMap = new Map();
    for (const d of defaultInitial.domains)
        domainMap.set(d.domain.toLowerCase(), d);
    for (const d of backup.domains)
        domainMap.set(d.domain.toLowerCase(), d);
    for (const d of primary.domains)
        domainMap.set(d.domain.toLowerCase(), d);
    const emailMap = new Map();
    for (const b of defaultInitial.bypassEmails)
        emailMap.set(b.email.toLowerCase(), b);
    for (const b of backup.bypassEmails)
        emailMap.set(b.email.toLowerCase(), b);
    for (const b of primary.bypassEmails)
        emailMap.set(b.email.toLowerCase(), b);
    const merged = {
        domains: Array.from(domainMap.values()),
        bypassEmails: Array.from(emailMap.values()),
    };
    if (!hasPrimary) {
        try {
            fs_1.default.mkdirSync(path_1.default.dirname(DATA_FILE_PATH), { recursive: true });
            fs_1.default.writeFileSync(DATA_FILE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
            fs_1.default.writeFileSync(BACKUP_FILE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
        }
        catch { }
    }
    return merged;
}
/**
 * Write updated data to local JSON storage and backup file.
 */
function writeLocalData(data) {
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(DATA_FILE_PATH), { recursive: true });
        fs_1.default.writeFileSync(DATA_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
        fs_1.default.writeFileSync(BACKUP_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    }
    catch (err) {
        console.error('[AccessControl] Failed to write access-control files:', err);
    }
}
let dbTablesInitialized = false;
/**
 * Ensures AllowedUniversityDomain and BypassEmail tables exist in PostgreSQL
 * and synchronizes initial seeds/data into the database without overwriting.
 */
async function ensureDatabaseTables() {
    if (dbTablesInitialized)
        return;
    try {
        await prisma_1.default.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AllowedUniversityDomain" (
        "id" TEXT PRIMARY KEY,
        "domain" TEXT UNIQUE NOT NULL,
        "name" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
        await prisma_1.default.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "BypassEmail" (
        "id" TEXT PRIMARY KEY,
        "email" TEXT UNIQUE NOT NULL,
        "note" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
        dbTablesInitialized = true;
        // Synchronize all existing local domains and bypass emails into DB so DB has full records
        const local = readLocalData();
        const prismaAny = prisma_1.default;
        if (prismaAny.allowedUniversityDomain) {
            for (const d of local.domains) {
                await prismaAny.allowedUniversityDomain.upsert({
                    where: { domain: d.domain },
                    update: { name: d.name },
                    create: {
                        id: d.id,
                        domain: d.domain,
                        name: d.name,
                        createdAt: new Date(d.createdAt || Date.now()),
                    },
                }).catch(() => { });
            }
        }
        if (prismaAny.bypassEmail) {
            for (const b of local.bypassEmails) {
                await prismaAny.bypassEmail.upsert({
                    where: { email: b.email },
                    update: { note: b.note },
                    create: {
                        id: b.id,
                        email: b.email,
                        note: b.note,
                        createdAt: new Date(b.createdAt || Date.now()),
                    },
                }).catch(() => { });
            }
        }
    }
    catch (err) {
        console.warn('[AccessControl] DB table auto-init notice:', err.message || err);
    }
}
/**
 * Retrieve all allowed university domains.
 * Merges PostgreSQL records with local storage so no custom user domain is ever lost.
 */
async function getAllowedDomains() {
    await ensureDatabaseTables();
    const localData = readLocalData();
    const mergedMap = new Map();
    // Add local entries first
    for (const d of localData.domains) {
        mergedMap.set(d.domain.toLowerCase(), d);
    }
    try {
        const prismaAny = prisma_1.default;
        if (prismaAny.allowedUniversityDomain) {
            const dbDomains = await prismaAny.allowedUniversityDomain.findMany({
                orderBy: { createdAt: 'desc' },
            });
            if (Array.isArray(dbDomains)) {
                for (const d of dbDomains) {
                    mergedMap.set(d.domain.toLowerCase(), {
                        id: d.id,
                        domain: d.domain,
                        name: d.name || undefined,
                        createdAt: d.createdAt?.toISOString?.() || String(d.createdAt),
                    });
                }
            }
        }
    }
    catch (err) {
        console.warn('[AccessControl] DB query for allowed domains failed, using local fallback:', err.message || err);
    }
    const result = Array.from(mergedMap.values());
    // Keep local storage & backup in sync with union
    localData.domains = result;
    writeLocalData(localData);
    return result;
}
/**
 * Retrieve all bypass student emails.
 * Merges PostgreSQL records with local storage so no custom bypass email is ever lost.
 */
async function getBypassEmails() {
    await ensureDatabaseTables();
    const localData = readLocalData();
    const mergedMap = new Map();
    // Add local entries first
    for (const b of localData.bypassEmails) {
        mergedMap.set(b.email.toLowerCase(), b);
    }
    try {
        const prismaAny = prisma_1.default;
        if (prismaAny.bypassEmail) {
            const dbEmails = await prismaAny.bypassEmail.findMany({
                orderBy: { createdAt: 'desc' },
            });
            if (Array.isArray(dbEmails)) {
                for (const b of dbEmails) {
                    mergedMap.set(b.email.toLowerCase(), {
                        id: b.id,
                        email: b.email,
                        note: b.note || undefined,
                        createdAt: b.createdAt?.toISOString?.() || String(b.createdAt),
                    });
                }
            }
        }
    }
    catch (err) {
        console.warn('[AccessControl] DB query for bypass emails failed, using local fallback:', err.message || err);
    }
    const result = Array.from(mergedMap.values());
    // Keep local storage & backup in sync with union
    localData.bypassEmails = result;
    writeLocalData(localData);
    return result;
}
/**
 * Add a new allowed university domain.
 * Directly persists to PostgreSQL and local cache.
 */
async function addAllowedDomain(rawDomain, name) {
    const cleanDomain = normalizeDomain(rawDomain);
    if (!cleanDomain) {
        throw new Error('A valid domain name is required (e.g. ves.ac.in or @ves.ac.in)');
    }
    await ensureDatabaseTables();
    const data = readLocalData();
    const existing = data.domains.find(d => d.domain.toLowerCase() === cleanDomain);
    if (existing) {
        return existing;
    }
    const newItem = {
        id: `dom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        domain: cleanDomain,
        name: name?.trim() || cleanDomain.toUpperCase(),
        createdAt: new Date().toISOString(),
    };
    data.domains.unshift(newItem);
    writeLocalData(data);
    // Directly persist to PostgreSQL
    try {
        const prismaAny = prisma_1.default;
        if (prismaAny.allowedUniversityDomain) {
            await prismaAny.allowedUniversityDomain.upsert({
                where: { domain: cleanDomain },
                update: { name: newItem.name },
                create: {
                    id: newItem.id,
                    domain: cleanDomain,
                    name: newItem.name,
                },
            });
        }
    }
    catch (dbErr) {
        console.warn('[AccessControl] DB upsert failed, saved locally:', dbErr);
    }
    return newItem;
}
/**
 * Remove an allowed university domain by ID or domain string.
 * Deletes from PostgreSQL and local cache.
 */
async function deleteAllowedDomain(idOrDomain) {
    const clean = normalizeDomain(idOrDomain);
    await ensureDatabaseTables();
    const data = readLocalData();
    const initialLen = data.domains.length;
    data.domains = data.domains.filter(d => d.id !== idOrDomain && d.domain.toLowerCase() !== clean);
    const removed = data.domains.length < initialLen;
    if (removed) {
        writeLocalData(data);
    }
    // Delete from PostgreSQL
    try {
        const prismaAny = prisma_1.default;
        if (prismaAny.allowedUniversityDomain) {
            await prismaAny.allowedUniversityDomain.deleteMany({
                where: {
                    OR: [{ id: idOrDomain }, { domain: clean }],
                },
            });
        }
    }
    catch (dbErr) {
        console.warn('[AccessControl] DB deletion failed:', dbErr);
    }
    return removed;
}
/**
 * Add a bypass student email.
 * Directly persists to PostgreSQL and local cache.
 */
async function addBypassEmail(rawEmail, note) {
    const cleanEmail = normalizeEmail(rawEmail);
    if (!cleanEmail || !cleanEmail.includes('@')) {
        throw new Error('A valid email address is required (e.g. user@gmail.com)');
    }
    await ensureDatabaseTables();
    const data = readLocalData();
    const existing = data.bypassEmails.find(b => b.email.toLowerCase() === cleanEmail);
    if (existing) {
        return existing;
    }
    const newItem = {
        id: `byp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        email: cleanEmail,
        note: note?.trim() || 'Allowed bypass student',
        createdAt: new Date().toISOString(),
    };
    data.bypassEmails.unshift(newItem);
    writeLocalData(data);
    // Directly persist to PostgreSQL
    try {
        const prismaAny = prisma_1.default;
        if (prismaAny.bypassEmail) {
            await prismaAny.bypassEmail.upsert({
                where: { email: cleanEmail },
                update: { note: newItem.note },
                create: {
                    id: newItem.id,
                    email: cleanEmail,
                    note: newItem.note,
                },
            });
        }
    }
    catch (dbErr) {
        console.warn('[AccessControl] DB upsert failed, saved locally:', dbErr);
    }
    return newItem;
}
/**
 * Remove a bypass email by ID or email string.
 * Deletes from PostgreSQL and local cache.
 */
async function deleteBypassEmail(idOrEmail) {
    const clean = normalizeEmail(idOrEmail);
    await ensureDatabaseTables();
    const data = readLocalData();
    const initialLen = data.bypassEmails.length;
    data.bypassEmails = data.bypassEmails.filter(b => b.id !== idOrEmail && b.email.toLowerCase() !== clean);
    const removed = data.bypassEmails.length < initialLen;
    if (removed) {
        writeLocalData(data);
    }
    // Delete from PostgreSQL
    try {
        const prismaAny = prisma_1.default;
        if (prismaAny.bypassEmail) {
            await prismaAny.bypassEmail.deleteMany({
                where: {
                    OR: [{ id: idOrEmail }, { email: clean }],
                },
            });
        }
    }
    catch (dbErr) {
        console.warn('[AccessControl] DB deletion failed:', dbErr);
    }
    return removed;
}
/**
 * Evaluates whether an email is eligible for university human coaching/counseling.
 *
 * Rule 1: Is this specific email explicitly registered in the Bypass list?
 * Rule 2: Does this email's domain match any Allowed University Domain?
 * Rule 3: Is there a verified University record in Prisma matching this domain?
 */
async function isStudentEligible(rawEmail) {
    if (!rawEmail) {
        return { eligible: false, reason: 'NOT_ELIGIBLE' };
    }
    const emailNorm = normalizeEmail(rawEmail);
    if (!emailNorm.includes('@')) {
        return { eligible: false, reason: 'NOT_ELIGIBLE' };
    }
    // 1. Check Bypass Emails (exact match)
    const bypassList = await getBypassEmails();
    const matchedBypass = bypassList.find(b => b.email.toLowerCase() === emailNorm);
    if (matchedBypass) {
        return {
            eligible: true,
            reason: 'BYPASS_EMAIL',
            matchedRule: matchedBypass.email,
        };
    }
    // Extract domain part
    const emailDomain = emailNorm.split('@')[1];
    if (!emailDomain) {
        return { eligible: false, reason: 'NOT_ELIGIBLE' };
    }
    // 2. Check Allowed University Domains
    const domainList = await getAllowedDomains();
    const matchedDomain = domainList.find(d => {
        const target = d.domain.toLowerCase();
        return emailDomain === target || emailDomain.endsWith(`.${target}`);
    });
    if (matchedDomain) {
        return {
            eligible: true,
            reason: 'UNIVERSITY_DOMAIN',
            domain: emailDomain,
            matchedRule: matchedDomain.domain,
        };
    }
    // 3. Check existing verified University table in Prisma if available
    try {
        const uni = await prisma_1.default.university.findFirst({
            where: {
                domain: { equals: emailDomain, mode: 'insensitive' },
                verified: true,
            },
        });
        if (uni) {
            return {
                eligible: true,
                reason: 'UNIVERSITY_DOMAIN',
                domain: emailDomain,
                matchedRule: uni.name,
            };
        }
    }
    catch {
        // If DB is offline, continue to fallback
    }
    return { eligible: false, reason: 'NOT_ELIGIBLE' };
}
