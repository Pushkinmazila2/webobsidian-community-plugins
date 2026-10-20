#!/usr/bin/env node
/**
 * Generate community-plugins.json (WebObsidian's compatibility list).
 *
 *   node scripts/generate.mjs [--caps capabilities.json] [--out community-plugins.json] [--cache data/usage-cache.json]
 *                             [--budget-minutes 300] [--concurrency 12] [--force] [--only id1,id2] [--limit N]
 *
 * Exit code 0 also when the budget ran out (the next run continues); non-zero only when nothing usable could be produced.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { run } from './lib/generate.mjs';

const { values: a } = parseArgs({
  options: {
    caps: { type: 'string', default: 'capabilities.json' },
    out: { type: 'string', default: 'community-plugins.json' },
    cache: { type: 'string', default: 'data/usage-cache.json' },
    'budget-minutes': { type: 'string' },
    concurrency: { type: 'string', default: '12' },
    force: { type: 'boolean', default: false },
    only: { type: 'string' },
    limit: { type: 'string' },
  },
});

const caps = JSON.parse(fs.readFileSync(a.caps, 'utf8'));
const summary = await run({
  caps,
  cacheFile: a.cache,
  outFile: a.out,
  force: a.force,
  budgetMs: a['budget-minutes'] ? Number(a['budget-minutes']) * 60_000 : undefined,
  concurrency: Number(a.concurrency),
  only: a.only ? a.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  limit: a.limit ? Number(a.limit) : undefined,
});
if (process.env.GITHUB_STEP_SUMMARY) {
  const t = summary.totals;
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Plugin compatibility\n\n| full | partial | broken | not checked |\n|---:|---:|---:|---:|\n| ${t.full} | ${t.partial} | ${t.broken} | ${t.unknown} |\n\n` +
      `Scanned ${summary.scanned} (${summary.failed} failed), deferred ${summary.deferred}, ${summary.seconds}s.\n`,
  );
}
