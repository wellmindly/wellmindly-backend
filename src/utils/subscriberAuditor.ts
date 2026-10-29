export interface SubscriberRecord {
  id: string;
  name: string;
  email: string;
  subject?: string | null;
  message?: string | null;
  createdAt: Date | string;
}

export interface DuplicateGroup {
  normalizedEmail: string;
  campaign: string;
  records: SubscriberRecord[];
  count: number;
}

export function analyzeSubscribers(records: SubscriberRecord[]) {
  const isNewsletterWaitlist = (r: SubscriberRecord) => {
    const nameMatch = r.name === 'Newsletter Subscriber' || r.name === 'Newsletter Waitlist';
    const subjMatch =
      (r.subject || '').toLowerCase().includes('waitlist') ||
      (r.subject || '').toLowerCase().includes('newsletter');
    return nameMatch || subjMatch;
  };

  const waitlistRecords = records.filter(isNewsletterWaitlist);
  const groups = new Map<string, SubscriberRecord[]>();
  const dailyDistribution = new Map<string, number>();

  for (const record of waitlistRecords) {
    const normEmail = record.email.trim().toLowerCase();
    const campaign = (record.subject || 'Waitlist: Human Counselling for All Students').trim().toLowerCase();
    const key = `${normEmail}::${campaign}`;

    const existing = groups.get(key) || [];
    existing.push(record);
    groups.set(key, existing);

    const dateKey = new Date(record.createdAt).toISOString().split('T')[0];
    dailyDistribution.set(dateKey, (dailyDistribution.get(dateKey) || 0) + 1);
  }

  const duplicates: DuplicateGroup[] = [];
  let totalDuplicates = 0;

  for (const [key, group] of groups.entries()) {
    if (group.length > 1) {
      const [normEmail, campaign] = key.split('::');
      // Sort oldest first
      group.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      duplicates.push({
        normalizedEmail: normEmail,
        campaign,
        records: group,
        count: group.length,
      });
      totalDuplicates += group.length - 1;
    }
  }

  // Sort duplicates descending by count
  duplicates.sort((a, b) => b.count - a.count);

  return {
    totalRecords: records.length,
    waitlistRecordsCount: waitlistRecords.length,
    uniqueSubscribers: groups.size,
    duplicateGroupsCount: duplicates.length,
    totalRedundantRecords: totalDuplicates,
    topDuplicateEmails: duplicates.slice(0, 15).map((d) => ({
      email: d.normalizedEmail,
      count: d.count,
      campaign: d.campaign,
      firstSubmission: d.records[0].createdAt,
      lastSubmission: d.records[d.records.length - 1].createdAt,
    })),
    dailyDistribution: Object.fromEntries(
      Array.from(dailyDistribution.entries()).sort(([a], [b]) => a.localeCompare(b))
    ),
    duplicateGroups: duplicates,
  };
}
