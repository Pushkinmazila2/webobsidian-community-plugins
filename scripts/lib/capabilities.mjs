/**
 * capabilities.json — what WebObsidian's Obsidian-API shim can and cannot do.
 *
 * Two sources, both from the WebObsidian checkout:
 *  1. docs/plugin-api-status.json — written by scripts/plugin-api-report.mjs, which compares obsidian.d.ts with
 *     web/src/lib/obsidianApi.ts (the "type parsing"): every class member / function / constant of the real API with
 *     its status in the shim.
 *  2. web/src/lib/plugins.ts and web/src/lib/obsidianUtils.ts, read with regular expressions: which modules
 *     `require()` may return inside a plugin, and the API version the shim declares.
 *
 * Status of an API item:
 *   ok       implemented
 *   partial  implemented, with known limits (requestUrl goes through a server proxy, getLeaf is a facade, …)
 *   noop     present but does nothing (mostly lifecycle hooks a plugin overrides anyway)
 *   missing  absent: using it throws or does nothing useful
 */
import { createHash } from 'node:crypto';

export const SCHEMA = 1;

/** Stable JSON: object keys sorted, so the same content always hashes the same. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const shortHash = (v) => createHash('sha256').update(typeof v === 'string' ? v : stableStringify(v)).digest('hex').slice(0, 12);

const bare = (name) => name.replace(/^static /, '');
/** Status as written in plugin-api-status.json → capability status. */
function statusOf(row) {
  if (row.status === 'ok') return 'ok';
  if (row.status === 'stub') return row.stubKind === 'partial' ? 'partial' : 'noop';
  return 'missing';
}

/** Module names the plugin loader answers to, read from web/src/lib/plugins.ts. */
export function parseModules(pluginsTs) {
  const modules = { obsidian: 'ok' };
  const externals = /const\s+EXTERNALS\b[^=]*=\s*\{([\s\S]*?)\n\};/.exec(pluginsTs);
  if (!externals) throw new Error('capabilities: could not find EXTERNALS in plugins.ts (loader changed?)');
  for (const m of externals[1].matchAll(/['"]([^'"]+)['"]\s*:/g)) modules[m[1]] = 'ok';
  
  const standardNodeBuiltins = [
    'fs', 'path', 'crypto', 'os', 'child_process', 'http', 'https', 
    'net', 'stream', 'tls', 'url', 'util', 'zlib', 'electron'
  ];
  
  for (const m of standardNodeBuiltins) {
    modules[m] = 'unavailable';
  }
  if (modules['path']) modules['path'] = 'shim';
  return modules;
}

/** The API version the shim reports (`requireApiVersion`, `apiVersion`). */
export function parseDeclaredApiVersion(utilsTs) {
  const m = /export\s+const\s+API_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/.exec(utilsTs);
  if (!m) throw new Error('capabilities: could not find API_VERSION in obsidianUtils.ts');
  return m[1];
}

/**
 * @param {object} input
 * @param {object} input.status    parsed docs/plugin-api-status.json
 * @param {string} input.pluginsTs  contents of web/src/lib/plugins.ts
 * @param {string} input.utilsTs    contents of web/src/lib/obsidianUtils.ts
 * @param {object} [input.source]   { repo, ref, commit } — informational
 * @param {string} [input.generatedAt]
 */
export function buildCapabilities({ status, pluginsTs, utilsTs, source, generatedAt }) {
  const classes = {};
  const functions = {};
  const constants = {};
  const feasibility = {};
  const totals = { ok: 0, partial: 0, noop: 0, missing: 0 };
  const names = new Set();

  for (const c of status.classes) {
    const entry = { present: c.classStatus !== 'missing', ok: [], partial: [], noop: [], missing: [] };
    names.add(c.name);
    if (!entry.present) {
      totals.missing++;
      feasibility[c.name] = c.feasibility;
    }
    for (const m of c.members) {
      const st = statusOf(m);
      entry[st].push(m.name);
      names.add(bare(m.name));
      totals[st]++;
      if (st === 'missing' || st === 'noop') feasibility[`${c.name}.${bare(m.name)}`] = m.feasibility;
    }
    for (const k of ['ok', 'partial', 'noop', 'missing']) entry[k].sort();
    classes[c.name] = entry;
  }
  for (const [rows, out] of [[status.functions, functions], [status.consts, constants]]) {
    for (const f of rows) {
      const st = statusOf(f);
      out[f.name] = st;
      names.add(f.name);
      totals[st]++;
      if (st === 'missing') feasibility[f.name] = f.feasibility;
    }
  }

  const modules = parseModules(pluginsTs);
  const api = { declared: parseDeclaredApiVersion(utilsTs), dts: status.apiVersion };
  const body = { api, classes, functions, constants, modules };
  return {
    schema: SCHEMA,
    generatedAt: generatedAt ?? new Date().toISOString(),
    // hash: changes when any verdict-relevant fact changes → plugins are re-classified.
    hash: shortHash(body),
    // namesHash: changes only when the set of API names changes (new Obsidian API) → cached source scans go stale.
    namesHash: shortHash([...names].sort()),
    ...(source ? { source } : {}),
    api,
    totals,
    classes: sortKeys(classes),
    functions: sortKeys(functions),
    constants: sortKeys(constants),
    modules: sortKeys(modules),
    feasibility: sortKeys(feasibility),
  };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Write-friendly text: one class per line keeps diffs reviewable without a 700-line pretty print. */
export function serializeCapabilities(caps) {
  const lines = [];
  const block = (key, obj) => {
    lines.push(`  ${JSON.stringify(key)}: {`);
    const keys = Object.keys(obj);
    keys.forEach((k, i) => lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}${i < keys.length - 1 ? ',' : ''}`));
    lines.push('  }');
  };
  const { classes, functions, constants, modules, feasibility, ...head } = caps;
  lines.push('{');
  for (const [k, v] of Object.entries(head)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  for (const [k, v] of [['classes', classes], ['functions', functions], ['constants', constants], ['modules', modules], ['feasibility', feasibility]]) {
    block(k, v);
    if (k !== 'feasibility') lines[lines.length - 1] += ',';
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}
