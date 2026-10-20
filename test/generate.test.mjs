import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildCapabilities } from '../scripts/lib/capabilities.mjs';
import { fetchText, pool } from '../scripts/lib/net.mjs';
import { run, SCANNER } from '../scripts/lib/generate.mjs';

const status = {
  apiVersion: '1.14.4',
  classes: [
    { name: 'Plugin', classStatus: 'ok', feasibility: 'easy', members: [] },
    { name: 'WorkspaceTabs', classStatus: 'missing', feasibility: 'hard', members: [] },
  ],
  functions: [],
  consts: [],
};
const pluginsTs = "const EXTERNALS = {\n};\nconst NODE_BUILTINS = new Set(['fs', 'electron']);\n";
const caps = buildCapabilities({ status, pluginsTs, utilsTs: "export const API_VERSION = '1.12.7';" });

const LIST = 'https://list/community-plugins.json';
const STATS = 'https://list/stats.json';
const GOOD = 'var o=require("obsidian");class P extends o.Plugin{}';
const PARTIAL = 'var o=require("obsidian");if(o.WorkspaceTabs){}';
const BROKEN_DESKTOP = 'var o=require("obsidian");var fs=require("fs");class P extends o.Plugin{}';

/**
 * A fake internet: the official list, the stats file and, per repository, a root manifest.json, tagged releases and a
 * "latest" release. `rel(repo, manifest, main)` is the common case: root manifest + a release tagged with its version
 * (which is also the latest one).
 */
function world() {
  const w = {
    list: [
      { id: 'good', name: 'Good', author: 'a', description: 'd', repo: 'o/good' },
      { id: 'part', name: 'Part', author: 'a', description: 'd', repo: 'o/part' },
      { id: 'desk', name: 'Desk', author: 'a', description: 'd', repo: 'o/desk' },
      { id: 'none', name: 'None', author: 'a', description: 'd', repo: 'o/none' },
    ],
    stats: { good: { downloads: 10, updated: 1 }, part: { downloads: 50, updated: 1 }, desk: { downloads: 5, updated: 1 }, none: { downloads: 1, updated: 1 } },
    heads: {}, tags: {}, latest: {},
    calls: [],
    failing: new Set(),
  };
  w.rel = (repo, manifest, main) => {
    w.heads[repo] = manifest;
    w.tags[repo] = { ...(w.tags[repo] ?? {}), [manifest.version]: { manifest, main } };
    w.latest[repo] = { manifest, main };
  };
  w.rel('o/good', { id: 'good', version: '1.0.0' }, GOOD);
  w.rel('o/part', { id: 'part', version: '2.0.0', minAppVersion: '1.0.0' }, PARTIAL);
  w.rel('o/desk', { id: 'desk', version: '1.0.0', isDesktopOnly: true }, BROKEN_DESKTOP);
  const file = (rel, name) => (!rel ? { status: 404 } : { status: 200, text: name === 'manifest.json' ? JSON.stringify(rel.manifest) : rel.main });
  w.fetchText = async (url) => {
    w.calls.push(url);
    if (url === LIST) return { status: 200, text: JSON.stringify(w.list) };
    if (url === STATS) return { status: 200, text: JSON.stringify(w.stats) };
    let m;
    if ((m = /raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/HEAD\/manifest\.json$/.exec(url))) {
      if (w.failing.has(m[1])) throw new Error('network down');
      return w.heads[m[1]] ? { status: 200, text: JSON.stringify(w.heads[m[1]]) } : { status: 404 };
    }
    if ((m = /github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(url))) {
      if (w.failing.has(m[1])) throw new Error('network down');
      return file(w.tags[m[1]]?.[m[2]], m[3]);
    }
    if ((m = /github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/(.+)$/.exec(url))) {
      if (w.failing.has(m[1])) throw new Error('network down');
      return file(w.latest[m[1]], m[2]);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return w;
}
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-'));
  return { dir, out: path.join(dir, 'community-plugins.json'), cache: path.join(dir, 'data/usage-cache.json') };
};
const opts = (t, extra = {}) => ({ caps, listUrl: LIST, statsUrl: STATS, outFile: t.out, cacheFile: t.cache, log: () => {}, ...extra });
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const byId = (t) => Object.fromEntries(read(t.out).plugins.map((p) => [p.id, p]));
const downloads = (w) => w.calls.filter((u) => u !== LIST && u !== STATS);

test('rates every plugin from its release and writes the list', async () => {
  const w = world(); const t = tmp();
  const s = await run(opts(t), w);
  const p = byId(t);
  assert.deepEqual([p.good.compat, p.part.compat, p.desk.compat, p.none.compat], ['full', 'partial', 'broken', 'broken']);
  assert.match(p.part.reasons[0], /WorkspaceTabs/);
  assert.match(p.none.reasons[0], /cannot install/);
  assert.equal(p.part.version, '2.0.0');
  assert.equal(p.desk.desktopOnly, true);
  assert.equal(p.good.downloads, 10);
  assert.equal(p.good.name, 'Good', 'name/description come from the official list');
  assert.deepEqual(s.totals, { full: 1, partial: 1, broken: 2, unknown: 0 });
  assert.equal(read(t.out).capabilities.hash, caps.hash);
});

test('a second run downloads nothing and changes nothing (same file, same timestamp)', async () => {
  const w = world(); const t = tmp();
  await run(opts(t), w);
  const first = fs.readFileSync(t.out, 'utf8');
  w.calls.length = 0;
  const s = await run(opts(t, { }), { ...w, fetchText: w.fetchText, now: () => Date.now() + 1000 });
  assert.equal(downloads(w).length, 0);
  assert.equal(s.scanned, 0);
  assert.equal(s.changed, false);
  assert.equal(fs.readFileSync(t.out, 'utf8'), first);
});

test('only plugins whose release changed are downloaded again', async () => {
  const w = world(); const t = tmp();
  await run(opts(t), w);
  w.calls.length = 0;
  w.stats.good.updated = 2; // a new release of "good"
  w.rel('o/good', { id: 'good', version: '1.1.0' }, PARTIAL);
  const s = await run(opts(t), w);
  assert.equal(s.scanned, 1);
  assert.ok(downloads(w).length > 0 && downloads(w).every((u) => u.includes('o/good')));
  assert.equal(byId(t).good.version, '1.1.0');
  assert.equal(byId(t).good.compat, 'partial');
});

test('a change in WebObsidian capabilities re-rates from the cache without downloading — unless the API names changed', async () => {
  const w = world(); const t = tmp();
  await run(opts(t), w);
  w.calls.length = 0;
  // WorkspaceTabs becomes supported: same names, new statuses
  const better = buildCapabilities({ status: { ...status, classes: [status.classes[0], { name: 'WorkspaceTabs', classStatus: 'ok', feasibility: 'hard', members: [] }] }, pluginsTs, utilsTs: "export const API_VERSION = '1.12.7';" });
  assert.equal(better.namesHash, caps.namesHash);
  assert.notEqual(better.hash, caps.hash);
  await run(opts(t, { caps: better }), w);
  assert.equal(downloads(w).length, 0, 'no download');
  assert.equal(byId(t).part.compat, 'full', 're-rated');
  // a brand-new API name → plugins must be rescanned
  const renamed = buildCapabilities({ status: { ...status, classes: [...status.classes, { name: 'Brand', classStatus: 'ok', feasibility: 'easy', members: [] }] }, pluginsTs, utilsTs: "export const API_VERSION = '1.12.7';" });
  await run(opts(t, { caps: renamed }), w);
  assert.ok(downloads(w).length > 0);
});

test('a network error keeps the previous rating and is retried on the next run', async () => {
  const w = world(); const t = tmp();
  await run(opts(t), w);
  w.stats.part.updated = 2;
  w.failing.add('o/part');
  let s = await run(opts(t), w);
  assert.equal(s.failed, 1);
  assert.equal(byId(t).part.compat, 'partial', 'rating survives the outage');
  w.failing.clear();
  w.rel('o/part', { id: 'part', version: '2.0.0', minAppVersion: '1.0.0' }, GOOD);
  s = await run(opts(t), w);
  assert.equal(s.scanned, 1, 'retried');
  assert.equal(byId(t).part.compat, 'full');
});

test('never-scanned plugins that fail show as unknown, not broken', async () => {
  const w = world(); const t = tmp();
  w.failing.add('o/good');
  await run(opts(t), w);
  assert.equal(byId(t).good.compat, 'unknown');
});

test('the time budget stops cleanly, popular plugins first, and the next run continues', async () => {
  const w = world(); const t = tmp();
  let clock = 0;
  const now = () => clock;
  const slow = { ...w, now, fetchText: async (u) => { const r = await w.fetchText(u); if (u.endsWith('main.js')) clock += 1000; return r; } };
  const s = await run(opts(t, { budgetMs: 1500, concurrency: 1 }), slow);
  assert.ok(s.deferred > 0 && s.scanned < 4);
  const p = byId(t);
  assert.equal(p.part.compat, 'partial', 'highest download count was done first');
  assert.equal(p.good.compat === 'unknown' || p.desk.compat === 'unknown' || p.none.compat === 'unknown', true);
  await run(opts(t), w);
  assert.equal(Object.values(byId(t)).filter((x) => x.compat === 'unknown').length, 0);
});

test('a truncated official list does not wipe the result', async () => {
  const w = world(); const t = tmp();
  w.list = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: 'n', author: 'a', description: 'd', repo: `o/p${i}` }));
  w.stats = {};
  await run(opts(t), w);
  w.list = w.list.slice(0, 3);
  await assert.rejects(run(opts(t), w), /refusing to continue/);
  assert.equal(read(t.out).plugins.length, 40);
});

test('plugins removed from the official list disappear; --only limits a run', async () => {
  const w = world(); const t = tmp();
  await run(opts(t), w);
  w.list = w.list.filter((p) => p.id !== 'none');
  await run(opts(t), w);
  assert.equal(read(t.out).plugins.length, 3);
  assert.ok(!('none' in read(t.cache).plugins));
  const w2 = world(); const t2 = tmp();
  await run(opts(t2, { only: ['good'] }), w2);
  assert.equal(downloads(w2).length, 3, 'root manifest + the release\'s main.js and manifest.json: one plugin only');
});

test('fetchText: retries 5xx with backoff, treats 404 as absent, caps the size', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let n = 0;
  const res = (status, body = '', headers = {}) => new Response(body, { status, headers });
  const flaky = async () => (++n < 3 ? res(503) : res(200, 'ok'));
  assert.equal((await fetchText('https://x', { fetchImpl: flaky, sleep })).text, 'ok');
  assert.equal(sleeps.length, 2);
  assert.equal((await fetchText('https://x', { fetchImpl: async () => res(404), sleep })).status, 404);
  assert.equal((await fetchText('https://x', { fetchImpl: async () => res(200, 'x'.repeat(100)), maxBytes: 10, sleep })).status, 413);
  await assert.rejects(fetchText('https://x', { fetchImpl: async () => res(500), sleep, retries: 1 }), /HTTP 500/);
});

test('pool: respects concurrency and the deadline', async () => {
  let active = 0, peak = 0;
  const r = await pool([1, 2, 3, 4, 5, 6], 2, async () => { active++; peak = Math.max(peak, active); await new Promise((x) => setTimeout(x, 5)); active--; });
  assert.equal(peak, 2);
  assert.equal(r.done, 6);
  let clock = 0;
  const r2 = await pool([1, 2, 3, 4], 1, async () => { clock += 10; }, { deadline: 25, now: () => clock });
  assert.deepEqual(r2, { done: 3, skipped: 1 });
});

test('the release tagged with the root manifest version is scanned, not the repository\'s latest release (beta channels)', async () => {
  const w = world(); const t = tmp();
  // like liamcain/obsidian-calendar-plugin: stable 1.5.10 in the catalogue, but "latest" is a beta with another id
  w.rel('o/good', { id: 'good', version: '1.0.0' }, GOOD);
  w.latest['o/good'] = { manifest: { id: 'good-beta', version: '2.0.0-beta' }, main: BROKEN_DESKTOP };
  await run(opts(t, { only: ['good'] }), w);
  const p = byId(t).good;
  assert.equal(p.compat, 'full');
  assert.equal(p.version, '1.0.0');
});

test('falls back to the latest release when the tag or the root manifest is missing', async () => {
  const w = world(); const t = tmp();
  delete w.tags['o/good']['1.0.0']; // tag named differently (e.g. "v1.0.0")
  delete w.heads['o/part']; // no root manifest
  await run(opts(t), w);
  const p = byId(t);
  assert.equal(p.good.compat, 'full');
  assert.equal(p.part.compat, 'partial');
  assert.equal(p.part.version, '2.0.0');
});

test('a release without its own manifest.json falls back to the root one; a release with a broken manifest is broken', async () => {
  const w = world(); const t = tmp();
  const orig = w.fetchText;
  w.fetchText = async (u) => (/o\/desk\/releases\/download\/1\.0\.0\/manifest\.json$/.test(u) ? { status: 404 } : orig(u));
  await run(opts(t), w);
  assert.equal(byId(t).desk.desktopOnly, true, 'isDesktopOnly taken from the root manifest');
  assert.equal(byId(t).desk.compat, 'broken');
});

test('a cache written by an older scanner version is redone', async () => {
  const w = world(); const t = tmp();
  await run(opts(t), w);
  const cache = read(t.cache);
  assert.equal(cache.scanner, SCANNER);
  cache.scanner = SCANNER - 1;
  fs.writeFileSync(t.cache, JSON.stringify(cache));
  w.calls.length = 0;
  const s = await run(opts(t), w);
  assert.equal(s.scanned, 4);
  assert.ok(downloads(w).length > 0);
});
