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
 * Read data from local JSON storage with safe fallback.
 */
function readLocalData(): AccessControlData {
  try {
    if (!fs.existsSync(DATA_FILE_PATH)) {
      const initial: AccessControlData = {
        domains: [
          {
            id: 'dom_ves_ac_in',
            domain: 'ves.ac.in',
            name: 'VES College (VESIT / VES)',
            createdAt: new Date().toISOString(),
          },
        ],
        bypassEmails: [
          {
            id: 'byp_jmalani54',
            email: 'jmalani54@gmail.com',
            note: 'Admin Test / VIP Bypass Access',
            createdAt: new Date().toISOString(),
          },
        ],
      };
      fs.mkdirSync(path.dirname(DATA_FILE_PATH), { recursive: true });
      fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(initial, null, 2), 'utf-8');
      return initial;
    }
    const raw = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      domains: Array.isArray(parsed.domains) ? parsed.domains : [],
      bypassEmails: Array.isArray(parsed.bypassEmails) ? parsed.bypassEmails : [],
    };
  } catch (err) {
    console.warn('[AccessControl] Failed to read access-control.json, using in-memory fallback:', err);
    return {
      domains: [
        {
          id: 'dom_ves_ac_in',
          domain: 'ves.ac.in',
          name: 'VES College (VESIT / VES)',
          createdAt: new Date().toISOString(),
        },
      ],
      bypassEmails: [
        {
          id: 'byp_jmalani54',
          email: 'jmalani54@gmail.com',
          note: 'Admin Test / VIP Bypass Access',
          createdAt: new Date().toISOString(),
        },
      ],
    };
  }
}

/**
 * Write updated data to local JSON storage.
 */
function writeLocalData(data: AccessControlData): void {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE_PATH), { recursive: true });
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[AccessControl] Failed to write access-control.json:', err);
  }
}

/**
 * Retrieve all allowed university domains.
 * Attempts DB retrieval if model exists, seamlessly merged with local storage.
 */
export async function getAllowedDomains(): Promise<AllowedDomainItem[]> {
  const local = readLocalData().domains;
  try {
    // Check if AllowedUniversityDomain model is available on prisma instance
    const prismaAny = prisma as any;
    if (prismaAny.allowedUniversityDomain) {
      const dbDomains = await prismaAny.allowedUniversityDomain.findMany({
        orderBy: { createdAt: 'desc' },
      });
      if (Array.isArray(dbDomains) && dbDomains.length > 0) {
        // Merge DB and local without duplicates
        const map = new Map<string, AllowedDomainItem>();
        for (const item of local) {
          map.set(item.domain.toLowerCase(), item);
        }
        for (const d of dbDomains) {
          map.set(d.domain.toLowerCase(), {
            id: d.id,
            domain: d.domain,
            name: d.name || undefined,
            createdAt: d.createdAt?.toISOString?.() || String(d.createdAt),
          });
        }
        return Array.from(map.values());
      }
    }
  } catch {
    // DB not available or table not migrated yet; gracefully fallback
  }
  return local;
}

/**
 * Retrieve all bypass student emails.
 */
export async function getBypassEmails(): Promise<BypassEmailItem[]> {
  const local = readLocalData().bypassEmails;
  try {
    const prismaAny = prisma as any;
    if (prismaAny.bypassEmail) {
      const dbEmails = await prismaAny.bypassEmail.findMany({
        orderBy: { createdAt: 'desc' },
      });
      if (Array.isArray(dbEmails) && dbEmails.length > 0) {
        const map = new Map<string, BypassEmailItem>();
        for (const item of local) {
          map.set(item.email.toLowerCase(), item);
        }
        for (const b of dbEmails) {
          map.set(b.email.toLowerCase(), {
            id: b.id,
            email: b.email,
            note: b.note || undefined,
            createdAt: b.createdAt?.toISOString?.() || String(b.createdAt),
          });
        }
        return Array.from(map.values());
      }
    }
  } catch {
    // DB fallback
  }
  return local;
}

/**
 * Add a new allowed university domain.
 */
export async function addAllowedDomain(rawDomain: string, name?: string): Promise<AllowedDomainItem> {
  const cleanDomain = normalizeDomain(rawDomain);
  if (!cleanDomain) {
    throw new Error('A valid domain name is required (e.g. ves.ac.in or @ves.ac.in)');
  }

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

  // Attempt DB persistence in background
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
 */
export async function deleteAllowedDomain(idOrDomain: string): Promise<boolean> {
  const clean = normalizeDomain(idOrDomain);
  const data = readLocalData();
  const initialLen = data.domains.length;

  data.domains = data.domains.filter(
    d => d.id !== idOrDomain && d.domain.toLowerCase() !== clean
  );

  const removed = data.domains.length < initialLen;
  if (removed) {
    writeLocalData(data);
  }

  // Attempt DB deletion
  try {
    const prismaAny = prisma as any;
    if (prismaAny.allowedUniversityDomain) {
      await prismaAny.allowedUniversityDomain.deleteMany({
        where: {
          OR: [{ id: idOrDomain }, { domain: clean }],
        },
      });
    }
  } catch {
    // Ignore DB error
  }

  return removed;
}

/**
 * Add a bypass student email.
 */
export async function addBypassEmail(rawEmail: string, note?: string): Promise<BypassEmailItem> {
  const cleanEmail = normalizeEmail(rawEmail);
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('A valid email address is required (e.g. user@gmail.com)');
  }

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

  // Attempt DB persistence
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
 */
export async function deleteBypassEmail(idOrEmail: string): Promise<boolean> {
  const clean = normalizeEmail(idOrEmail);
  const data = readLocalData();
  const initialLen = data.bypassEmails.length;

  data.bypassEmails = data.bypassEmails.filter(
    b => b.id !== idOrEmail && b.email.toLowerCase() !== clean
  );

  const removed = data.bypassEmails.length < initialLen;
  if (removed) {
    writeLocalData(data);
  }

  // Attempt DB deletion
  try {
    const prismaAny = prisma as any;
    if (prismaAny.bypassEmail) {
      await prismaAny.bypassEmail.deleteMany({
        where: {
          OR: [{ id: idOrEmail }, { email: clean }],
        },
      });
    }
  } catch {
    // Ignore DB error
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
