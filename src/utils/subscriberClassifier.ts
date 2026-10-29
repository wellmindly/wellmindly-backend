/**
 * Subscriber Classification Utility
 * Intelligently classifies contact/newsletter submissions into REAL vs FAKE (bots/spammers).
 * 
 * Real subscribers are preserved and deduplicated into the active ContactRequest table.
 * Fake bot submissions are quarantined into the ArchivedFakeContactRequest table.
 */

// Known disposable/temporary email provider domains
const DISPOSABLE_DOMAINS = new Set([
  'tempmail.com', '10minutemail.com', 'mailinator.com', 'guerrillamail.com',
  'sharklasers.com', 'yopmail.com', 'trashmail.com', 'throwawaymail.com',
  'dispostable.com', 'getairmail.com', 'fakemailgenerator.com', 'mytemp.email',
  'temp-mail.org', 'burnermail.io', 'mohmal.com', 'crazymailing.com',
  'dropmail.me', 'getnada.com', 'inboxkitten.com', 'tempmailo.com'
]);

// Common human first names to guard against false positives in syllabic/character checks
const COMMON_FIRST_NAMES = new Set([
  'melisa', 'melissa', 'marilyn', 'pauline', 'verma', 'john', 'cynthia', 'vanessa', 'andreas',
  'stefanie', 'frank', 'claus', 'izabela', 'luzia', 'marcia', 'anthony', 'sangeeta', 'henry',
  'david', 'michael', 'sarah', 'jessica', 'brian', 'kevin', 'daniel', 'thomas', 'robert',
  'james', 'william', 'mary', 'patricia', 'jennifer', 'linda', 'elizabeth', 'barbara',
  'susan', 'karen', 'anna', 'emma', 'olivia', 'sophia', 'isabella', 'charlotte', 'amelia'
]);

// Common English words found in business or personal handles
const COMMON_WORDS = [
  'sun', 'world', 'doors', 'landscape', 'tech', 'media', 'creative', 'design',
  'support', 'info', 'contact', 'office', 'admin', 'sales', 'billing', 'press'
];

export interface SubscriberClassification {
  email: string;
  normalizedEmail: string;
  isFake: boolean;
  score: number; // 0 (definitely real) - 100 (definitely fake/bot)
  reasons: string[];
}

/**
 * Classifies an email address and its submission pattern as REAL or FAKE.
 *
 * @param email Raw or normalized email
 * @param submissionCount Number of times this email appeared in submission floods
 */
export function classifySubscriber(email: string, submissionCount: number = 1): SubscriberClassification {
  const normalizedEmail = (email || '').trim().toLowerCase();
  const reasons: string[] = [];
  let botScore = 0;

  const parts = normalizedEmail.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return {
      email,
      normalizedEmail,
      isFake: true,
      score: 100,
      reasons: ['Malformed or invalid email structure'],
    };
  }

  const [localPart, domain] = parts;

  // 1. Check known disposable burner domains
  if (DISPOSABLE_DOMAINS.has(domain)) {
    botScore += 100;
    reasons.push(`Disposable email domain (${domain})`);
  }

  // 2. Dot-trick spam pattern (bot marker: 4+ dots with multiple short 1-2 char fragments)
  const dotCount = (localPart.match(/\./g) || []).length;
  if (dotCount >= 3) {
    const segments = localPart.split('.');
    const shortFragments = segments.filter((s) => s.length <= 2).length;
    if (dotCount >= 4 && shortFragments >= 3) {
      botScore += 85;
      reasons.push(`Dot-trick spam signature (${dotCount} dots, ${shortFragments} micro-segments)`);
    }
  }

  // 3. Repeated triple identical non-zero characters (e.g. nfs333pt, ffreyyebrhggh)
  // Exclude 000 (common in birth years like 2000)
  if (/([a-z1-9])\1{2,}/i.test(localPart)) {
    let hasKnownWord = false;
    for (const word of COMMON_WORDS) {
      if (localPart.includes(word)) {
        hasKnownWord = true;
        break;
      }
    }
    if (!hasKnownWord) {
      botScore += 75;
      reasons.push('Repeated identical character cluster');
    }
  }

  // 4. Excessive unpronounceable consonant mash (6+ consecutive consonants without vowel/y)
  if (/[^aeiouy\d._-]{6,}/i.test(localPart)) {
    let hasWord = false;
    for (const w of COMMON_WORDS) {
      if (localPart.includes(w)) {
        hasWord = true;
        break;
      }
    }
    if (!hasWord) {
      botScore += 85;
      reasons.push('Unpronounceable consonant cluster (6+ consecutive consonants)');
    }
  }

  // 5. Automated phonetic syllable generator ending in digits:
  // e.g. ubavucuqepi58 (u-ba-vu-cu-qe-pi + 58), opufonezexa799, fikiqonubu42, licehajowe486, yuqodujol509
  const alphaOnly = localPart.replace(/\d+/g, '');
  const digitsOnly = localPart.replace(/\D+/g, '');
  const isVowel = (c: string) => 'aeiou'.includes(c);

  let startsWithHumanName = false;
  for (const name of COMMON_FIRST_NAMES) {
    if (alphaOnly.startsWith(name)) {
      startsWithHumanName = true;
      break;
    }
  }

  if (
    !startsWithHumanName &&
    digitsOnly.length >= 2 &&
    digitsOnly.length <= 4 &&
    alphaOnly.length >= 8 &&
    alphaOnly.length <= 14
  ) {
    let alternating = true;
    for (let i = 0; i < alphaOnly.length - 1; i++) {
      if (isVowel(alphaOnly[i]) === isVowel(alphaOnly[i + 1])) {
        alternating = false;
        break;
      }
    }
    const hasUnusualLetter = /[qxz]/.test(alphaOnly) || submissionCount >= 5;
    if (alternating && hasUnusualLetter) {
      botScore += 85;
      reasons.push('Automated alternating syllabic bot generator with trailing digits');
    }
  }

  // 6. High submission flood (>15x) from public webmail without legitimate personal name format
  if (submissionCount >= 15 && ['gmail.com', 'outlook.com', 'yahoo.com'].includes(domain)) {
    const isHumanName = /^[a-z]{2,15}[._-][a-z]{2,20}/.test(localPart);
    if (!startsWithHumanName && !isHumanName) {
      botScore += 40;
      reasons.push(`High submission frequency flood (${submissionCount} submissions)`);
    }
  }

  // Human safeguards & domain reputation
  const isAcademic =
    domain.endsWith('.edu') ||
    domain.includes('.edu.') ||
    domain.endsWith('.ac.in') ||
    domain.endsWith('.ac.uk') ||
    domain.endsWith('.org');

  const isCustomOrRegionalDomain = ![
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'aol.com',
    'icloud.com',
    'mail.ru',
  ].includes(domain);

  const isHumanNameFormat = /^[a-z]{2,15}[._-][a-z]{2,20}(\d{2,4})?$/.test(localPart);

  if (isAcademic) {
    botScore = Math.max(0, botScore - 60);
    reasons.push('Verified academic domain');
  } else if (isCustomOrRegionalDomain && !DISPOSABLE_DOMAINS.has(domain) && botScore < 80) {
    // Only grant custom domain discount if the address does not have extreme bot markers
    botScore = Math.max(0, botScore - 40);
    reasons.push(`Legitimate organizational/regional domain (${domain})`);
  }

  if (isHumanNameFormat && dotCount <= 2) {
    botScore = Math.max(0, botScore - 50);
    reasons.push('Human firstname.lastname format');
  }

  const isFake = botScore >= 60;

  return {
    email,
    normalizedEmail,
    isFake,
    score: botScore,
    reasons: reasons.length ? reasons : ['Legitimate human subscriber profile'],
  };
}
