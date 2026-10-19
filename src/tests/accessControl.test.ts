import { describe, it, expect } from 'vitest';
import {
  normalizeDomain,
  normalizeEmail,
  isStudentEligible,
  getAllowedDomains,
  getBypassEmails,
  addAllowedDomain,
  deleteAllowedDomain,
  addBypassEmail,
  deleteBypassEmail,
} from '../services/accessControl';

describe('Access Control Service', () => {
  it('normalizes domains properly', () => {
    expect(normalizeDomain('@ves.ac.in')).toBe('ves.ac.in');
    expect(normalizeDomain('  @VES.AC.IN  ')).toBe('ves.ac.in');
    expect(normalizeDomain('https://harvard.edu/test')).toBe('harvard.edu');
    expect(normalizeDomain('mit.edu/')).toBe('mit.edu');
  });

  it('normalizes emails properly', () => {
    expect(normalizeEmail('  JMalani54@Gmail.Com  ')).toBe('jmalani54@gmail.com');
  });

  it('recognizes pre-seeded bypass email jmalani54@gmail.com', async () => {
    const result = await isStudentEligible('jmalani54@gmail.com');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('BYPASS_EMAIL');
  });

  it('recognizes pre-seeded university domain ves.ac.in', async () => {
    const result = await isStudentEligible('student123@ves.ac.in');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('UNIVERSITY_DOMAIN');
    expect(result.domain).toBe('ves.ac.in');
  });

  it('recognizes subdomain of allowed university domain', async () => {
    const result = await isStudentEligible('alice@engg.ves.ac.in');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('UNIVERSITY_DOMAIN');
  });

  it('rejects non-whitelisted email domains', async () => {
    const result = await isStudentEligible('unauthorized@gmail.com');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('NOT_ELIGIBLE');
  });

  it('can dynamically add and delete allowed domains', async () => {
    const added = await addAllowedDomain('@stanford.edu', 'Stanford University');
    expect(added.domain).toBe('stanford.edu');

    const checkBefore = await isStudentEligible('john@stanford.edu');
    expect(checkBefore.eligible).toBe(true);
    expect(checkBefore.reason).toBe('UNIVERSITY_DOMAIN');

    await deleteAllowedDomain(added.id);
    const checkAfter = await isStudentEligible('john@stanford.edu');
    expect(checkAfter.eligible).toBe(false);
  });

  it('can dynamically add and delete bypass emails', async () => {
    const added = await addBypassEmail('testvip@outlook.com', 'VIP User');
    expect(added.email).toBe('testvip@outlook.com');

    const checkBefore = await isStudentEligible('testvip@outlook.com');
    expect(checkBefore.eligible).toBe(true);
    expect(checkBefore.reason).toBe('BYPASS_EMAIL');

    await deleteBypassEmail(added.id);
    const checkAfter = await isStudentEligible('testvip@outlook.com');
    expect(checkAfter.eligible).toBe(false);
  });
});
