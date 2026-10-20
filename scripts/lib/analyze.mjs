/**
 * Static analysis of a community plugin's main.js against capabilities.json.
 *
 * Two phases, so a change in WebObsidian's capabilities does not mean downloading thousands of plugins again:
 *   extractUsage(source, index) → what the plugin touches (independent of what WebObsidian supports; cacheable)
 *   classify(usage, manifest, caps, index) → "full" | "partial" | "broken", the reasons and flags
 *
 * This is a heuristic over bundled/minified JavaScript, not a runtime test. Evidence, all taken from *code* only
 * (strings, template text, regex literals and comments are blanked first — code generators such as ajv contain
 * `require("…")` inside template strings that never runs):
 *   1. `require("obsidian")` aliases → which Obsidian classes/functions are used, and which are extended;
 *   2. method names that exist only in API parts WebObsidian lacks;
 *   3. `require()` of Node/Electron or unknown modules, combined with the manifest's `isDesktopOnly`.
 * "WebObsidian is like Obsidian Mobile": a plugin that declares itself usable on mobile cannot depend on Node, so
 * Node references in it are dead desktop branches; a desktop-only plugin that reaches for `fs`/`electron`/
 * `child_process` is rated broken.
 */

const IDENT = '[A-Za-z_$][\\w$]*';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Node/Electron modules a plugin cannot do without once it needs them (vs. small helpers like `os`). */
export const HARD_MODULES = new Set([
  'electron', 'child_process', 'fs', 'fs/promises', 'original-fs', 'net', 'tls', 'http', 'https', 'worker_threads', 'vm', 'zlib', 'module', 'readline',
]);

/** Member names too generic to be evidence by themselves. */
const GENERIC_MEMBERS = new Set(['settings', 'app', 'file', 'parent', 'collapsed', 'toggle', 'expand', 'collapse', 'clear', 'get', 'set']);
/** Only camelCase names of 8+ characters are distinctive enough to match by name alone (`hoverPopover`, `getBasePath`). */
export const isDistinctiveMember = (name) => name.length >= 8 && /^[a-z][a-z0-9]*[A-Z]/.test(name) && !GENERIC_MEMBERS.has(name);

const bare = (name) => name.replace(/^static /, '');

/** Lookup tables derived from capabilities.json. */
export function buildIndex(caps) {
  /** name → { kind, status } for everything `require("obsidian")` is supposed to export */
  const top = new Map();
  for (const [name, c] of Object.entries(caps.classes)) top.set(name, { kind: 'class', status: c.present ? 'ok' : 'missing' });
  for (const [name, st] of Object.entries(caps.functions)) top.set(name, { kind: 'function', status: st });
  for (const [name, st] of Object.entries(caps.constants)) if (!top.has(name)) top.set(name, { kind: 'constant', status: st });

  /** member name → [{ owner, status }] across all classes */
  const owners = new Map();
  for (const [cls, c] of Object.entries(caps.classes)) {
    for (const status of ['ok', 'partial', 'noop', 'missing']) {
      for (const m of c[status]) {
        const n = bare(m);
        if (!owners.has(n)) owners.set(n, []);
        owners.get(n).push({ owner: cls, status });
      }
    }
  }
  /** Names worth looking for in source at all (a shape rule, independent of support status) — what extractUsage records. */
  const watched = [...owners.keys()].filter(isDistinctiveMember).sort();
  /** …of which these are evidence of trouble: missing in every class that defines them. */
  const missingMembers = new Map();
  for (const n of watched) {
    const list = owners.get(n);
    if (list.every((o) => o.status === 'missing')) missingMembers.set(n, list.map((o) => o.owner));
  }
  // `.name` (member access, `?.name` too); the name must end there so `.getBasePathX` is not `.getBasePath`
  const watchRe = watched.length ? new RegExp(`\\.\\s*(${watched.map(esc).join('|')})(?![\\w$])`, 'g') : null;
  return { top, owners, watched, watchRe, missingMembers };
}

// ---- reading code, not text ----------------------------------------------------------------------------------

/**
 * Inline sourcemaps and embedded fonts/images/wasm are megabytes of base64 that no pattern needs — and long runs of
 * word characters are what makes identifier-anchored regexes slow. Real code never has 300 such characters in a row
 * (it is broken up by dots, parentheses, commas, spaces, …).
 */
export const stripNoise = (s) =>
  s
    .replace(/\/\/[#@]\s*sourceMappingURL=data:[^\n]*/g, '')
    // `+` and a length check, not `{300,}`: V8 overflows its regexp stack on a multi-megabyte run
    .replace(/[A-Za-z0-9+/=_-]+/g, (run) => (run.length >= 300 ? ' ' : run));

// After these a `/` starts a regular expression; after anything else (identifier, number, `)`, `]`, string) it divides.
const REGEX_AFTER_CHAR = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'delete', 'void', 'throw', 'new', 'instanceof', 'yield', 'await']);
const isWordCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;

/**
 * The same text with the inside of strings, template literals (their static parts), regular expressions and comments
 * replaced by spaces — same length, so offsets line up with the original. Quote characters stay, so `require("   ")`
 * is still recognisable as a call whose argument is a string; read the argument from the original by offset.
 * Not a full JS parser: when `/` is ambiguous it guesses from the previous token, and a string never runs past its
 * line, so one misjudgement cannot swallow the rest of the file.
 */
export function maskNonCode(src) {
  const n = src.length;
  const out = [];
  let pos = 0; // start of the code not yet copied to `out`
  const mask = (a, b) => { if (b > a) { out.push(src.slice(pos, a), ' '.repeat(b - a)); pos = b; } };
  let i = 0;
  let prev = ''; // previous significant token: one char, 'a' for a word/number/string, or a regex-introducing keyword as '('
  let depth = 0;
  const tpl = []; // brace depth at which each open `${` started

  /** Scan template text from `from` until the closing backtick or the next `${`; returns the index to resume code at. */
  const template = (from) => {
    let j = from;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 96) { mask(from, j); prev = 'a'; return j + 1; }
      if (c === 36 && src.charCodeAt(j + 1) === 123) { mask(from, j); tpl.push(depth++); prev = '{'; return j + 2; }
      j++;
    }
    mask(from, n);
    return n;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    if (c === 47) { // /
      const d = src.charCodeAt(i + 1);
      if (d === 47) { let j = src.indexOf('\n', i); if (j < 0) j = n; mask(i, j); i = j; continue; }
      if (d === 42) { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; mask(i, j); i = j; continue; }
      if (REGEX_AFTER_CHAR.has(prev)) {
        let j = i + 1;
        let inClass = false;
        for (; j < n; j++) {
          const e = src.charCodeAt(j);
          if (e === 92) { j++; continue; }
          if (e === 10 || e === 13) { j = -1; break; }
          if (e === 91) inClass = true;
          else if (e === 93) inClass = false;
          else if (e === 47 && !inClass) break;
        }
        if (j > 0 && j < n) { mask(i + 1, j); i = j + 1; while (i < n && /[a-z]/.test(src[i])) i++; prev = 'a'; continue; }
      }
      prev = '/'; i++; continue;
    }
    if (c === 34 || c === 39) { // " '
      let j = i + 1;
      while (j < n) {
        const e = src.charCodeAt(j);
        if (e === 92) { j += 2; continue; }
        if (e === c || e === 10) break;
        j++;
      }
      mask(i + 1, Math.min(j, n));
      i = j < n && src.charCodeAt(j) === c ? j + 1 : j;
      prev = 'a';
      continue;
    }
    if (c === 96) { i = template(i + 1); continue; } // `
    if (c === 123) { depth++; prev = '{'; i++; continue; }
    if (c === 125) { // }
      if (tpl.length && depth - 1 === tpl[tpl.length - 1]) { depth--; tpl.pop(); i = template(i + 1); continue; }
      depth--; prev = '}'; i++; continue;
    }
    if (isWordCode(c)) {
      let j = i + 1;
      while (j < n && isWordCode(src.charCodeAt(j))) j++;
      prev = REGEX_AFTER_WORD.has(src.slice(i, j)) ? '(' : 'a';
      i = j;
      continue;
    }
    prev = src[i];
    i++;
  }
  out.push(src.slice(pos));
  return out.join('');
}

/**
 * What the plugin touches. A pure function of the source and the API *names* (index.top / index.watchRe), not of
 * their support status — so the result stays valid when WebObsidian's capabilities change.
 */
export function extractUsage(source, index) {
  const src = stripNoise(source);
  const code = maskNonCode(src);
  const aliases = new Set();
  const api = new Set();
  const ext = new Set();
  const direct = new Set(); // names destructured straight out of require("obsidian")
  const requires = new Set();
  const topRequires = new Set(); // required at brace depth 0: runs while the plugin loads, not only when a feature is used
  let scanned = 0;
  let depth = 0;
  const depthAt = (idx) => {
    for (; scanned < idx; scanned++) {
      const c = code.charCodeAt(scanned);
      if (c === 123) depth++;
      else if (c === 125) depth--;
    }
    return depth;
  };

  // Every require("…") call in code; the module name is read from the original text at the blanked argument.
  for (const m of code.matchAll(/(?<![\w$.])(?:__)?require\(\s*(["'`])( *)\1\s*\)/gd)) {
    const [a, b] = m.indices[2];
    const name = src.slice(a, b).replace(/^node:/, '');
    if (name !== 'obsidian') {
      requires.add(name);
      if (depthAt(m.index) <= 0) topRequires.add(name);
      continue;
    }
    // How the result is bound: `var x = require("obsidian")`, `x = __toESM(require("obsidian"))`, `{ A, B: C } = require(…)`
    const before = code.slice(Math.max(0, m.index - 400), m.index);
    const bound = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$.]+\(\s*)*$/.exec(before);
    const destructured = /\{([^{}]{0,400})\}\s*=\s*(?:[\w$.]+\(\s*)*$/.exec(before);
    if (bound) aliases.add(bound[1]);
    else if (destructured) {
      for (const part of destructured[1].split(',')) {
        const key = part.split(':')[0].split('=')[0].trim();
        if (new RegExp(`^${IDENT}$`).test(key)) { direct.add(key); api.add(key); }
      }
    }
    const after = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(m.index + m[0].length, m.index + m[0].length + 80)); // require("obsidian").Notice
    if (after) api.add(after[1]);
  }

  for (const alias of aliases) {
    const a = esc(alias);
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${a}\\.(${IDENT})`, 'g'))) api.add(m[1]);
    // class X extends alias.Y · TS/ES5: __extends(X, alias.Y) · }(alias.Y)) · (0, alias.Y)
    for (const re of [`extends\\s+(?:\\(\\s*0\\s*,\\s*)?${a}\\.(${IDENT})`, `__extends\\(\\s*${IDENT}\\s*,\\s*${a}\\.(${IDENT})\\s*\\)`, `\\}\\(\\s*${a}\\.(${IDENT})\\s*\\)\\)`]) {
      for (const m of code.matchAll(new RegExp(re, 'g'))) ext.add(m[1]);
    }
  }
  for (const name of direct) if (new RegExp(`extends\\s+${esc(name)}(?![\\w$])`).test(code)) ext.add(name);

  // Only names that are really part of the Obsidian API count; anything else is an unrelated `x.foo`.
  const known = (set) => [...set].filter((n) => index.top.has(n)).sort();

  const members = new Set();
  if (index.watchRe) for (const m of code.matchAll(index.watchRe)) members.add(m[1]);

  const signals = [];
  if (/(?<![\w$])(?:window|global|globalThis)\s*\.\s*require\s*\(/.test(code)) signals.push('windowRequire');
  // eval(), x.eval.call(…), new Function("…"). `Function("return this")` is global-object sniffing in many libraries — ignore it.
  let evalHit = /(?<![\w$])eval\s*[.(]/.test(code);
  if (!evalHit) {
    for (const m of code.matchAll(/(?<![\w$.])(?:new\s+)?Function\s*\(\s*(?=["'`])/g)) {
      const arg = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (!/^["'`]\s*return\s*\(?\s*this\b/.test(arg)) { evalHit = true; break; }
    }
  }
  if (evalHit) signals.push('eval');

  // Regex captures and slices are *views* into the 12 MB source they came from, so keeping one alive keeps the whole
  // masked copy alive: thousands of plugins in the cache would exhaust the heap. Copy each name into a string of its own.
  const own = (names) => names.map((n) => Buffer.from(n, 'utf8').toString('utf8'));
  return {
    size: source.length,
    api: own(known(api)),
    extends: own(known(ext)),
    members: own([...members].sort()),
    requires: own([...requires].sort()),
    topRequires: own([...topRequires].sort()),
    signals,
  };
}

/** "1.10.3" vs "1.12.7": numeric compare, missing parts are 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const list = (items, max = 4) => (items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max} more)` : items.join(', '));

/**
 * @returns {{ compat: 'full'|'partial'|'broken', reasons: string[], flags: string[] }}
 *   reasons — why it is not "full"; flags — facts worth showing that do not change the rating
 *   (`eval`: needs WEBOBSIDIAN_ALLOW_UNSAFE_EVAL=1 for the features that use it).
 */
export function classify(usage, manifest, caps, index) {
  const broken = [];
  const partial = [];
  const desktopOnly = manifest?.isDesktopOnly === true;

  // 1. Obsidian API the plugin touches
  const missingTop = usage.api.filter((n) => index.top.get(n)?.status === 'missing');
  const extendsMissing = usage.extends.filter((n) => missingTop.includes(n));
  const fsAdapter = missingTop.filter((n) => /^(FileSystemAdapter|CapacitorAdapter)$/.test(n));
  if (extendsMissing.length) broken.push(`Extends Obsidian class(es) WebObsidian lacks: ${list(extendsMissing)}`);
  if (fsAdapter.length && desktopOnly) broken.push(`Needs the local filesystem (${list(fsAdapter)}) — desktop-only plugin`);
  const restTop = missingTop.filter((n) => !extendsMissing.includes(n) && !(desktopOnly && fsAdapter.includes(n)));
  if (restTop.length) partial.push(`Uses Obsidian API missing in WebObsidian: ${list(restTop)}`);
  const missingMembers = usage.members.filter((n) => index.missingMembers.has(n));
  if (missingMembers.length) partial.push(`Calls methods missing in WebObsidian: ${list(missingMembers)}`);

  // 2. require() of other modules
  const unsupported = [];
  const hardNode = [];
  const softNode = [];
  for (const m of usage.requires) {
    const st = caps.modules[m];
    if (st === 'ok' || st === 'shim') continue;
    if (st === 'unavailable') (HARD_MODULES.has(m) ? hardNode : softNode).push(m);
    else unsupported.push(m); // the loader throws "required unsupported module" as soon as this runs
  }
  // The loader throws "required unsupported module" the moment such a require() runs: at load for top-level ones
  // (plugin never starts), later — when the feature using it runs — for the nested ones.
  const top = new Set(usage.topRequires ?? []);
  const unsupportedAtLoad = unsupported.filter((m) => top.has(m));
  const unsupportedLater = unsupported.filter((m) => !top.has(m));
  if (unsupportedAtLoad.length) broken.push(`Fails to load: requires module(s) WebObsidian cannot provide: ${list(unsupportedAtLoad)}`);
  if (unsupportedLater.length) partial.push(`Some features need module(s) WebObsidian cannot provide: ${list(unsupportedLater)}`);
  if (hardNode.length && desktopOnly) broken.push(`Needs Node/Electron (${list(hardNode)}) — desktop-only plugin`);
  if (usage.signals.includes('windowRequire') && desktopOnly) broken.push('Calls window.require() — desktop-only plugin with Node/Electron access');
  if (softNode.length && desktopOnly) partial.push(`Uses Node module(s) that do not exist in a browser: ${list(softNode)}`);

  // 3. Needs a newer Obsidian API than even the d.ts WebObsidian was measured against: unknown territory
  if (manifest?.minAppVersion && compareVersions(manifest.minAppVersion, caps.api.dts) > 0) {
    partial.push(`Asks for Obsidian ${manifest.minAppVersion}, newer than the API WebObsidian was checked against (${caps.api.dts})`);
  }

  const reasons = [...broken, ...partial].slice(0, 5);
  const flags = usage.signals.includes('eval') ? ['eval'] : [];
  return { compat: broken.length ? 'broken' : partial.length ? 'partial' : 'full', reasons, flags };
}
