import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';

export interface AllowedDomainItem {
  id: string;
  domain: string;
  name?: string;
  createdAt: string;
}

export interface BypassEmailItem {
  id: string;
  email: string;
  note?: string;
  createdAt: string;
}

interface AccessControlData {
  domains: AllowedDomainItem[];
  bypassEmails: BypassEmailItem[];
}

const DATA_FILE_PATH = path.resolve(__dirname, '../../data/access-control.json');
const BACKUP_FILE_PATH = path.resolve(__dirname, '../../data/access-control.backup.json');

/**
 * Normalizes a domain string:
 * - strips whitespace and converts to lower case
 * - strips leading '@' (e.g., '@ves.ac.in' -> 'ves.ac.in')
 * - strips protocol (http:// or https://) if pasted by user
 * - strips trailing paths or slashes
 */
export function normalizeDomain(rawDomain: string): string {
  if (!rawDomain) return '';
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
export function normalizeEmail(rawEmail: string): string {
  if (!rawEmail) return '';
  return rawEmail.trim().toLowerCase();
}

/**
 * Read data from local JSON storage with safe fallback and backup merge.
 */
function readLocalData(): AccessControlData {
  const defaultInitial: AccessControlData = {
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

  let primary: AccessControlData = { domains: [], bypassEmails: [] };
  let hasPrimary = false;

  try {
    if (fs.existsSync(DATA_FILE_PATH)) {
      const raw = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      primary = {
        domains: Array.isArray(parsed.domains) ? parsed.domains : [],
        bypassEmails: Array.isArray(parsed.bypassEmails) ? parsed.bypassEmails : [],
      };
      hasPrimary = true;
    }
  } catch (err) {
    console.warn('[AccessControl] Failed reading DATA_FILE_PATH:', err);
  }

  // Check backup file to ensure no data is ever lost across resets
  let backup: AccessControlData = { domains: [], bypassEmails: [] };
  try {
    if (fs.existsSync(BACKUP_FILE_PATH)) {
      const rawBackup = fs.readFileSync(BACKUP_FILE_PATH, 'utf-8');
      const parsedBackup = JSON.parse(rawBackup);
      backup = {
        domains: Array.isArray(parsedBackup.domains) ? parsedBackup.domains : [],
        bypassEmails: Array.isArray(parsedBackup.bypassEmails) ? parsedBackup.bypassEmails : [],
      };
    }
  } catch (err) {
    console.warn('[AccessControl] Failed reading BACKUP_FILE_PATH:', err);
  }

  // Merge primary and backup by unique domain / email
  const domainMap = new Map<string, AllowedDomainItem>();
  for (const d of defaultInitial.domains) domainMap.set(d.domain.toLowerCase(), d);
  for (const d of backup.domains) domainMap.set(d.domain.toLowerCase(), d);
  for (const d of primary.domains) domainMap.set(d.domain.toLowerCase(), d);

  const emailMap = new Map<string, BypassEmailItem>();
  for (const b of defaultInitial.bypassEmails) emailMap.set(b.email.toLowerCase(), b);
  for (const b of backup.bypassEmails) emailMap.set(b.email.toLowerCase(), b);
  for (const b of primary.bypassEmails) emailMap.set(b.email.toLowerCase(), b);

  const merged: AccessControlData = {
    domains: Array.from(domainMap.values()),
    bypassEmails: Array.from(emailMap.values()),
  };

  if (!hasPrimary) {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE_PATH), { recursive: true });
      fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
      fs.writeFileSync(BACKUP_FILE_PATH, JSON.stringify(merged, null, 2), 'utf-8');
    } catch {}
  }

  return merged;
}

/**
 * Write updated data to local JSON storage and backup file.
 */
function writeLocalData(data: AccessControlData): void {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE_PATH), { recursive: true });
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
    fs.writeFileSync(BACKUP_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[AccessControl] Failed to write access-control files:', err);
  }
}

let dbTablesInitialized = false;

/**
 * Ensures AllowedUniversityDomain and BypassEmail tables exist in PostgreSQL
 * and synchronizes initial seeds/data into the database without overwriting.
 */
export async function ensureDatabaseTables(): Promise<void> {
  if (dbTablesInitialized) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AllowedUniversityDomain" (
        "id" TEXT PRIMARY KEY,
        "domain" TEXT UNIQUE NOT NULL,
        "name" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await prisma.$executeRawUnsafe(`
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
    const prismaAny = prisma as any;
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
        }).catch(() => {});
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
        }).catch(() => {});
      }
    }
  } catch (err: any) {
    console.warn('[AccessControl] DB table auto-init notice:', err.message || err);
  }
}

/**
 * Retrieve all allowed university domains.
 * Merges PostgreSQL records with local storage so no custom user domain is ever lost.
 */
export async function getAllowedDomains(): Promise<AllowedDomainItem[]> {
  await ensureDatabaseTables();
  const localData = readLocalData();
  const mergedMap = new Map<string, AllowedDomainItem>();

  // Add local entries first
  for (const d of localData.domains) {
    mergedMap.set(d.domain.toLowerCase(), d);
  }

  try {
    const prismaAny = prisma as any;
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
  } catch (err: any) {
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
export async function getBypassEmails(): Promise<BypassEmailItem[]> {
  await ensureDatabaseTables();
  const localData = readLocalData();
  const mergedMap = new Map<string, BypassEmailItem>();

  // Add local entries first
  for (const b of localData.bypassEmails) {
    mergedMap.set(b.email.toLowerCase(), b);
  }

  try {
    const prismaAny = prisma as any;
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
  } catch (err: any) {
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
export async function addAllowedDomain(rawDomain: string, name?: string): Promise<AllowedDomainItem> {
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

  const newItem: AllowedDomainItem = {
    id: `dom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    domain: cleanDomain,
    name: name?.trim() || cleanDomain.toUpperCase(),
    createdAt: new Date().toISOString(),
  };

  data.domains.unshift(newItem);
  writeLocalData(data);

  // Directly persist to PostgreSQL
  try {
    const prismaAny = prisma as any;
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
  } catch (dbErr) {
    console.warn('[AccessControl] DB upsert failed, saved locally:', dbErr);
  }

  return newItem;
}

/**
 * Remove an allowed university domain by ID or domain string.
 * Deletes from PostgreSQL and local cache.
 */
export async function deleteAllowedDomain(idOrDomain: string): Promise<boolean> {
  const clean = normalizeDomain(idOrDomain);
  await ensureDatabaseTables();
  const data = readLocalData();
  const initialLen = data.domains.length;

  data.domains = data.domains.filter(
    d => d.id !== idOrDomain && d.domain.toLowerCase() !== clean
  );

  const removed = data.domains.length < initialLen;
  if (removed) {
    writeLocalData(data);
  }

  // Delete from PostgreSQL
  try {
    const prismaAny = prisma as any;
    if (prismaAny.allowedUniversityDomain) {
      await prismaAny.allowedUniversityDomain.deleteMany({
        where: {
          OR: [{ id: idOrDomain }, { domain: clean }],
        },
      });
    }
  } catch (dbErr) {
    console.warn('[AccessControl] DB deletion failed:', dbErr);
  }

  return removed;
}

/**
 * Add a bypass student email.
 * Directly persists to PostgreSQL and local cache.
 */
export async function addBypassEmail(rawEmail: string, note?: string): Promise<BypassEmailItem> {
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

  const newItem: BypassEmailItem = {
    id: `byp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    email: cleanEmail,
    note: note?.trim() || 'Allowed bypass student',
    createdAt: new Date().toISOString(),
  };

  data.bypassEmails.unshift(newItem);
  writeLocalData(data);

  // Directly persist to PostgreSQL
  try {
    const prismaAny = prisma as any;
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
  } catch (dbErr) {
    console.warn('[AccessControl] DB upsert failed, saved locally:', dbErr);
  }

  return newItem;
}

/**
 * Remove a bypass email by ID or email string.
 * Deletes from PostgreSQL and local cache.
 */
export async function deleteBypassEmail(idOrEmail: string): Promise<boolean> {
  const clean = normalizeEmail(idOrEmail);
  await ensureDatabaseTables();
  const data = readLocalData();
  const initialLen = data.bypassEmails.length;

  data.bypassEmails = data.bypassEmails.filter(
    b => b.id !== idOrEmail && b.email.toLowerCase() !== clean
  );

  const removed = data.bypassEmails.length < initialLen;
  if (removed) {
    writeLocalData(data);
  }

  // Delete from PostgreSQL
  try {
    const prismaAny = prisma as any;
    if (prismaAny.bypassEmail) {
      await prismaAny.bypassEmail.deleteMany({
        where: {
          OR: [{ id: idOrEmail }, { email: clean }],
        },
      });
    }
  } catch (dbErr) {
    console.warn('[AccessControl] DB deletion failed:', dbErr);
  }

  return removed;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: 'BYPASS_EMAIL' | 'UNIVERSITY_DOMAIN' | 'NOT_ELIGIBLE';
  domain?: string;
  matchedRule?: string;
}

/**
 * Evaluates whether an email is eligible for university human coaching/counseling.
 *
 * Rule 1: Is this specific email explicitly registered in the Bypass list?
 * Rule 2: Does this email's domain match any Allowed University Domain?
 * Rule 3: Is there a verified University record in Prisma matching this domain?
 */
export async function isStudentEligible(rawEmail: string): Promise<EligibilityResult> {
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
    const uni = await prisma.university.findFirst({
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
  } catch {
    // If DB is offline, continue to fallback
  }

  return { eligible: false, reason: 'NOT_ELIGIBLE' };
}
