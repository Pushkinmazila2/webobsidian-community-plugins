#!/usr/bin/env node
/**
 * Build capabilities.json from a WebObsidian checkout.
 *
 *   node scripts/build-capabilities.mjs --webobsidian ../webobsidian [--obsidian-api ../obsidian-api] [--out capabilities.json]
 *
 * With --obsidian-api the API report is regenerated first (needs `typescript` installable in the checkout), so the
 * result reflects the current source rather than the last committed docs/plugin-api-status.json.
 * `generatedAt` only moves when the content changes, so an unchanged shim produces no diff and no commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { buildCapabilities, serializeCapabilities } from './lib/capabilities.mjs';

const { values: a } = parseArgs({
  options: {
    webobsidian: { type: 'string' },
    'obsidian-api': { type: 'string' },
    out: { type: 'string', default: 'capabilities.json' },
    repo: { type: 'string' },
    ref: { type: 'string' },
  },
});
if (!a.webobsidian) {
  console.error('usage: build-capabilities.mjs --webobsidian <checkout> [--obsidian-api <checkout>] [--out file] [--repo owner/name] [--ref branch]');
  process.exit(2);
}
const root = path.resolve(a.webobsidian);

if (a['obsidian-api']) {
  // plugin-api-report.mjs drives the TypeScript compiler API; WebObsidian pins ^5, and the newest major (7, native) has a
  // different JS API, so a fresh checkout must not get "latest".
  const tsPkg = path.join(root, 'node_modules/typescript/package.json');
  const tsMajor = fs.existsSync(tsPkg) ? Number(JSON.parse(fs.readFileSync(tsPkg, 'utf8')).version.split('.')[0]) : 0;
  if (tsMajor !== 5) {
    console.log('installing typescript@5 into the WebObsidian checkout (needed by plugin-api-report.mjs)…');
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock', 'typescript@^5.6.3'], { cwd: root, stdio: 'inherit' });
  }
  execFileSync('node', ['scripts/plugin-api-report.mjs', path.resolve(a['obsidian-api'])], { cwd: root, stdio: 'inherit' });
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let commit;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }

const caps = buildCapabilities({
  status: JSON.parse(read('docs/plugin-api-status.json')),
  pluginsTs: read('web/src/lib/plugins.ts'),
  utilsTs: read('web/src/lib/obsidianUtils.ts'),
  source: a.repo || commit ? { ...(a.repo ? { repo: a.repo } : {}), ...(a.ref ? { ref: a.ref } : {}), ...(commit ? { commit } : {}) } : undefined,
});

// Keep the previous timestamp (and commit) when nothing verdict-relevant changed.
const out = path.resolve(a.out);
try {
  const old = JSON.parse(fs.readFileSync(out, 'utf8'));
  if (old.hash === caps.hash && old.namesHash === caps.namesHash) {
    caps.generatedAt = old.generatedAt;
    if (old.source) caps.source = old.source;
  }
} catch { /* first run */ }

const text = serializeCapabilities(caps);
JSON.parse(text); // the hand-formatted output must still be valid JSON
const before = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
if (before !== text) fs.writeFileSync(out, text);
console.log(`capabilities: API ${caps.api.declared} (d.ts ${caps.api.dts}) — ok ${caps.totals.ok}, partial ${caps.totals.partial}, noop ${caps.totals.noop}, missing ${caps.totals.missing}; hash ${caps.hash}${before === text ? ' (unchanged)' : ' (written)'}`);
