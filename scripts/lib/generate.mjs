/**
 * Builds WebObsidian's community-plugins.json (the compatibility list) from Obsidian's official list.
 *
 * For every plugin: download its latest GitHub release (manifest.json + main.js — exactly what WebObsidian's installer
 * downloads), extract what main.js uses, and rate it against capabilities.json. Scans are cached in `cacheFile`
 * (a plugin is re-downloaded only when its release changed or the capabilities' API names changed); ratings are
 * recomputed from the cache on every run, so a change in WebObsidian's capabilities re-rates everything without a download.
 *
 * Built for >9 000 plugins on a daily schedule: popular plugins are scanned first, a time budget stops the run cleanly,
 * and the next run continues where this one stopped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchText as realFetchText, pool } from './net.mjs';
import { buildIndex, extractUsage, classify } from './analyze.mjs';

export const OFFICIAL_LIST = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/refs/heads/master/community-plugins.json';
export const OFFICIAL_STATS = 'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/refs/heads/master/community-plugin-stats.json';
export const SCHEMA = 1;
/** Bump when how plugins are fetched or analysed changes: every cached scan is then redone. */
export const SCANNER = 2;
export const COMPAT = ['full', 'partial', 'broken', 'unknown'];

const DAY = 86_400_000;
/** Plugins with no release info in the stats file, and states that may heal on their own, are looked at again after this long. */
const RECHECK_MS = 7 * DAY;

const NO_RELEASE = 'No GitHub release with manifest.json and main.js — WebObsidian cannot install it';

const parseObject = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

/**
 * Download and analyse one plugin — the files WebObsidian's installer would install, which are the ones Obsidian
 * itself would: the release tagged with the version in the root manifest.json. (A repository's *latest* release can
 * be a different plugin, e.g. a beta channel with another id; it is only the fallback, as in the installer.)
 * Never throws for "the plugin is not there"; throws for network trouble.
 */
export async function scanPlugin(repo, { getText, index }) {
  const head = await getText(`https://raw.githubusercontent.com/${repo}/HEAD/manifest.json`, { maxBytes: 1_000_000 });
  const headManifest = head.status === 200 ? parseObject(head.text) : null;
  const bases = [];
  if (typeof headManifest?.version === 'string' && /^[\w.+-]{1,64}$/.test(headManifest.version)) bases.push(`https://github.com/${repo}/releases/download/${headManifest.version}`);
  bases.push(`https://github.com/${repo}/releases/latest/download`);

  for (const base of bases) {
    const js = await getText(`${base}/main.js`, { maxBytes: 60 * 1048576 });
    if (js.status === 404) continue;
    // the release's own manifest.json is what gets installed; the root one stands in if the release lacks it
    const m = await getText(`${base}/manifest.json`, { maxBytes: 1_000_000 });
    const manifest = (m.status === 200 ? parseObject(m.text) : null) ?? (base === bases[0] ? headManifest : null);
    if (!manifest) return { state: m.status === 404 ? 'norelease' : 'badmanifest' };
    if (js.status === 413) return { state: 'toolarge', ...manifestFields(manifest) };
    if (js.status !== 200) return { state: 'nomain', ...manifestFields(manifest) };
    return { state: 'ok', ...manifestFields(manifest), usage: extractUsage(js.text, index) };
  }
  return { state: 'norelease' };
}

function manifestFields(m) {
  return {
    version: typeof m.version === 'string' ? m.version : undefined,
    minAppVersion: typeof m.minAppVersion === 'string' ? m.minAppVersion : undefined,
    desktopOnly: m.isDesktopOnly === true ? true : undefined,
  };
}

/** Rating of a cache record. */
export function rate(rec, caps, index) {
  if (!rec) return { compat: 'unknown', reasons: ['Not checked yet'] };
  switch (rec.state) {
    case 'ok': {
      const r = classify(rec.usage, { isDesktopOnly: rec.desktopOnly === true, minAppVersion: rec.minAppVersion }, caps, index);
      return r;
    }
    case 'norelease': case 'nomain': case 'badmanifest':
      return { compat: 'broken', reasons: [NO_RELEASE], flags: [] };
    case 'toolarge':
      return { compat: 'unknown', reasons: ['main.js is too large to analyse'], flags: [] };
    default:
      return { compat: 'unknown', reasons: ['Not checked yet'], flags: [] };
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * @param {object} o
 * @param {object} o.caps        parsed capabilities.json
 * @param {string} o.cacheFile   scan cache (read + written)
 * @param {string} o.outFile     community-plugins.json (read for change detection, written)
 * @param {boolean} [o.force]    rescan everything
 * @param {number} [o.budgetMs]  stop starting new scans after this long
 * @param {number} [o.concurrency]
 * @param {string[]} [o.only]    plugin ids to limit the run to (testing)
 * @param {number} [o.limit]     scan at most this many plugins (testing)
 */
export async function run(o, deps = {}) {
  const getText = deps.fetchText ?? realFetchText;
  const now = deps.now ?? Date.now;
  const log = o.log ?? console.log;
  const started = now();
  const caps = o.caps;
  const index = buildIndex(caps);

  const listRes = await getText(o.listUrl ?? OFFICIAL_LIST, { maxBytes: 50 * 1048576 });
  if (listRes.status !== 200) throw new Error(`Could not download the official plugin list (HTTP ${listRes.status})`);
  const list = JSON.parse(listRes.text);
  if (!Array.isArray(list)) throw new Error('The official plugin list is not an array');
  const previous = readJson(o.outFile, null);
  const prevCount = previous?.plugins?.length ?? 0;
  // A truncated or error response must not wipe the list.
  if (prevCount && list.length < prevCount * 0.5) throw new Error(`Official list has ${list.length} plugins, was ${prevCount}: refusing to continue`);

  let stats = {};
  try {
    const s = await getText(o.statsUrl ?? OFFICIAL_STATS, { maxBytes: 100 * 1048576 });
    if (s.status === 200) stats = JSON.parse(s.text);
    else log(`warning: plugin stats unavailable (HTTP ${s.status}); using age-based rescans`);
  } catch (e) { log(`warning: plugin stats unavailable (${e.message}); using age-based rescans`); }

  const entries = list.filter((p) => p && typeof p.id === 'string' && /^[\w.-]+\/[\w.-]+$/.test(p.repo ?? ''));
  const cache = readJson(o.cacheFile, { schema: SCHEMA, plugins: {} });
  if (cache.schema !== SCHEMA || !cache.plugins) { cache.schema = SCHEMA; cache.plugins = {}; }
  const namesChanged = cache.namesHash !== caps.namesHash || cache.scanner !== SCANNER;
  if (namesChanged && Object.keys(cache.plugins).length) log(`API names or scanner changed (${cache.namesHash}/${cache.scanner} → ${caps.namesHash}/${SCANNER}): rescanning every plugin`);
  cache.namesHash = caps.namesHash;
  cache.scanner = SCANNER;

  // ---- which plugins need a (re)scan ----
  const due = [];
  for (const p of entries) {
    if (o.only && !o.only.includes(p.id)) continue;
    const rec = cache.plugins[p.id];
    const st = stats[p.id];
    const age = rec ? started - Date.parse(rec.scannedAt) : Infinity;
    const stale =
      o.force || namesChanged || !rec || rec.repo !== p.repo || rec.state === 'error' ||
      (st ? rec.updated !== st.updated : age > RECHECK_MS) ||
      (rec.state !== 'ok' && age > RECHECK_MS);
    if (stale) due.push(p);
  }
  // never scanned first, then by popularity: if the budget runs out, the plugins people actually use are done
  due.sort((a, b) => Number(Boolean(cache.plugins[a.id])) - Number(Boolean(cache.plugins[b.id])) || (stats[b.id]?.downloads ?? 0) - (stats[a.id]?.downloads ?? 0));
  const queue = o.limit ? due.slice(0, o.limit) : due;
  log(`${entries.length} plugins in the official list; ${queue.length} to scan (${due.length - queue.length} deferred by --limit)`);

  // ---- scan ----
  let scanned = 0, failed = 0, sinceCheckpoint = 0;
  const checkpoint = () => { cache.updatedAt = new Date(now()).toISOString(); writeAtomic(o.cacheFile, JSON.stringify(cache)); sinceCheckpoint = 0; };
  const { skipped } = await pool(queue, o.concurrency ?? 12, async (p) => {
    const st = stats[p.id];
    try {
      const r = await scanPlugin(p.repo, { getText, index });
      cache.plugins[p.id] = { repo: p.repo, updated: st?.updated, scannedAt: new Date(now()).toISOString(), ...r };
    } catch (e) {
      failed++;
      const old = cache.plugins[p.id];
      // keep the last good scan (and its rating) through a network hiccup; retry on the next run
      cache.plugins[p.id] = old && old.state === 'ok'
        ? { ...old, scannedAt: old.scannedAt, updated: old.updated, lastError: String(e.message).slice(0, 120) }
        : { repo: p.repo, updated: st?.updated, scannedAt: new Date(now()).toISOString(), state: 'error', lastError: String(e.message).slice(0, 120) };
      if (old?.state === 'ok') cache.plugins[p.id].retry = true;
    }
    scanned++;
    if (++sinceCheckpoint >= 500) checkpoint();
    if (scanned % 250 === 0) log(`  scanned ${scanned}/${queue.length}…`);
  }, { deadline: o.budgetMs ? started + o.budgetMs : Infinity, now });
  // records kept through an error get another look next run
  for (const rec of Object.values(cache.plugins)) if (rec.retry) { rec.scannedAt = new Date(0).toISOString(); delete rec.retry; }

  // forget plugins removed from the official list
  const ids = new Set(entries.map((p) => p.id));
  for (const id of Object.keys(cache.plugins)) if (!ids.has(id)) delete cache.plugins[id];
  checkpoint();

  // ---- build the list ----
  const totals = { full: 0, partial: 0, broken: 0, unknown: 0 };
  const plugins = entries.map((p) => {
    const rec = cache.plugins[p.id];
    const r = rate(rec, caps, index);
    totals[r.compat]++;
    const dl = stats[p.id]?.downloads;
    return {
      id: p.id, name: p.name, author: p.author, description: p.description, repo: p.repo,
      ...(rec?.version ? { version: rec.version } : {}),
      ...(rec?.minAppVersion ? { minAppVersion: rec.minAppVersion } : {}),
      ...(rec?.desktopOnly ? { desktopOnly: true } : {}),
      ...(typeof dl === 'number' ? { downloads: dl } : {}),
      compat: r.compat,
      ...(r.reasons?.length ? { reasons: r.reasons } : {}),
      ...(r.flags?.length ? { flags: r.flags } : {}),
    };
  });
  const body = { schema: SCHEMA, capabilities: { hash: caps.hash, api: caps.api.declared, dts: caps.api.dts }, totals, plugins };
  // The timestamp moves only when the content does: an unchanged list produces no diff and no commit.
  const sameAsBefore = previous && JSON.stringify({ ...previous, generatedAt: undefined }) === JSON.stringify({ ...body, generatedAt: undefined })
    ? true : false;
  const result = { generatedAt: sameAsBefore ? previous.generatedAt : new Date(now()).toISOString(), ...body };
  const text = JSON.stringify(result) + '\n';
  const changed = !sameAsBefore;
  if (changed) writeAtomic(o.outFile, text);

  const summary = { total: entries.length, scanned, failed, deferred: skipped + (due.length - queue.length), totals, changed, seconds: Math.round((now() - started) / 1000) };
  log(`done: ${JSON.stringify(summary)}`);
  return summary;
}
