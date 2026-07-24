// Fails the workflow when a feed is genuinely unusable — but only AFTER the
// scrape has been committed and published.
//
// Splitting this out of scrape.js matters: if the scraper itself exited
// non-zero, the "Commit updated data" step would never run, so one broken feed
// would stop the other fifteen healthy ones from reaching the app. Publish
// first, complain second.

import { readFile } from 'node:fs/promises';

const STALE_FAIL_HOURS = 48;

const index = JSON.parse(
  await readFile(new URL('./docs/data/index.json', import.meta.url), 'utf8'),
);

const problems = [];
for (const [feed, s] of Object.entries(index.status || {})) {
  if (s.ok) continue;
  const errors = (s.errors || []).join('; ');
  if (s.staleHours == null) {
    problems.push(`${feed}: no data at all (all sources failed). ${errors}`);
  } else if (s.staleHours >= STALE_FAIL_HOURS) {
    problems.push(`${feed}: ${s.staleHours}h stale (all sources failed). ${errors}`);
  }
}

if (!problems.length) {
  const ok = Object.values(index.status || {}).filter((s) => s.ok).length;
  const total = Object.keys(index.status || {}).length;
  console.log(`Feed health OK — ${ok}/${total} feeds refreshed this run.`);
  process.exit(0);
}

for (const p of problems) {
  console.log(`::error title=Feed unusable::${p}`);
}
console.log(`\n${problems.length} feed(s) need attention:\n - ${problems.join('\n - ')}`);
process.exit(1);
