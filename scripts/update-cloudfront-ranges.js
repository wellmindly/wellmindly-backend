// Regenerates src/config/cloudfrontRanges.json from AWS's published ip-ranges.json
// (service CLOUDFRONT_ORIGIN_FACING: the addresses CloudFront uses to reach an origin).
// Usage: node scripts/update-cloudfront-ranges.js
const fs = require('fs');
const path = require('path');

(async () => {
  const res = await fetch('https://ip-ranges.amazonaws.com/ip-ranges.json');
  if (!res.ok) throw new Error(`ip-ranges.json: HTTP ${res.status}`);
  const d = await res.json();
  const v4 = d.prefixes.filter((p) => p.service === 'CLOUDFRONT_ORIGIN_FACING').map((p) => p.ip_prefix);
  const v6 = (d.ipv6_prefixes || [])
    .filter((p) => p.service === 'CLOUDFRONT_ORIGIN_FACING')
    .map((p) => p.ipv6_prefix);
  const ranges = [...new Set([...v4, ...v6])].sort();
  if (ranges.length < 10) throw new Error('Too few CloudFront ranges; refusing to write');
  const out = path.join(__dirname, '..', 'src', 'config', 'cloudfrontRanges.json');
  fs.writeFileSync(out, JSON.stringify({ createDate: d.createDate, ranges }, null, 2) + '\n');
  console.log(`wrote ${ranges.length} ranges (AWS createDate ${d.createDate})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
