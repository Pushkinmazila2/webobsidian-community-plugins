# webobsidian-community-plugins

Daily compatibility ratings of Obsidian community plugins for [WebObsidian](https://github.com/Pushkinmazila2/webobsidian).

Every day a GitHub Action reads Obsidian's official `community-plugins.json`, looks at each plugin's `main.js`, compares it
with what WebObsidian implements and publishes **`community-plugins.json`** with a rating per plugin:

| `compat` | meaning |
|---|---|
| `full` | everything the plugin uses exists in WebObsidian |
| `partial` | it should start, but some features use API/modules WebObsidian lacks (reasons are listed) |
| `broken` | expected not to work: needs Node/Electron in a desktop-only plugin, a module that cannot be provided at load time, or it has no release to install |
| `unknown` | not scanned yet (the first run takes a while; popular plugins go first) |

WebObsidian's plugin manager (Settings → Community Plugins → Browse) downloads this one file — never the 9 000 plugin
repositories — caches it, and refreshes it as often as the user configured.

## Files

| file | what |
|---|---|
| `capabilities.json` | what WebObsidian's Obsidian-API shim can do: per class `ok`/`partial`/`noop`/`missing` members, functions, constants, `require()`-able modules, declared API version |
| `community-plugins.json` | **the result** the plugin manager reads (minified, ~3 MB) |
| `data/usage-cache.json` | scan cache: what each plugin's `main.js` uses, keyed by its release; this is why a daily run only downloads what changed |
| `scripts/build-capabilities.mjs` | builds `capabilities.json` from a WebObsidian checkout |
| `scripts/generate.mjs` | scans plugins and writes `community-plugins.json` |
| `.github/workflows/update.yml` | the daily job |

## How a rating is made

1. **Capabilities** (`build-capabilities.mjs`). WebObsidian's `scripts/plugin-api-report.mjs` compares `obsidian.d.ts` (the real
   API) with the shim (`web/src/lib/obsidianApi.ts`) using the TypeScript parser → `docs/plugin-api-status.json`.
   Regular expressions then read the plugin loader (`web/src/lib/plugins.ts`) for the modules `require()` may return and
   `obsidianUtils.ts` for the declared API version.
2. **Scan** (`generate.mjs`). For each plugin the files are fetched the way Obsidian installs them: `manifest.json` at the root of
   the repository names a version, the release tagged with exactly that version holds `main.js`. (The repository's *latest*
   release is only a fallback — it can be a beta channel with another plugin id.)
3. **Analysis** (`lib/analyze.mjs`). The code is read with strings, template literals, regular expressions and comments blanked
   out (code generators such as ajv contain `require("…")` in template text that never runs). Then: which Obsidian classes and
   functions the plugin uses (through every alias shape esbuild/tsc produce), which classes it *extends*, which methods that exist
   only in missing parts of the API it calls, which Node/Electron/other modules it requires and whether that happens at load time or
   only inside a feature, `window.require`, `eval`.
4. **Rating.** Like Obsidian Mobile: a plugin that is not `isDesktopOnly` cannot depend on Node, so Node references in it are dead
   desktop branches; a desktop-only plugin that needs `fs`/`electron`/`child_process`/`FileSystemAdapter` is `broken`. Extending a class
   WebObsidian lacks, or an unavailable module required while loading, is `broken`; missing API used somewhere in the code is `partial`.
   `eval` is only a flag (`WEBOBSIDIAN_ALLOW_UNSAFE_EVAL=1` makes it work), not a downgrade.

This is a **static heuristic**, not a run of the plugin: use it as guidance. Ratings are recomputed from the cache on every run, so
improving WebObsidian changes them without downloading anything — unless the set of API *names* changed (new Obsidian API), which
rescans everything.

## Setting up (once)

1. *Settings → Actions → General → Workflow permissions*: **Read and write** (the job commits the result back).
2. Optional repository **variables** `WEBOBSIDIAN_REPO` / `WEBOBSIDIAN_REF` (defaults: `Pushkinmazila2/webobsidian`,
   `test/github-storage`): where WebObsidian's capabilities are read from. Switch the default to `main` once the plugin manager is
   merged there. If that repository were private, add a token and `token:` to its checkout step.
3. Run the workflow once by hand (*Actions → Update plugin compatibility → Run workflow*). The first run scans ~9 100 plugins
   (an hour or more); a time budget stops it cleanly before GitHub's 6-hour limit and the next daily run continues.
   Tick **force** to rescan everything.
4. WebObsidian reads
   `https://raw.githubusercontent.com/Pushkinmazila2/webobsidian-community-plugins/main/community-plugins.json`
   by default; a fork can be used through `WEBOBSIDIAN_PLUGIN_CATALOG_URL` on the WebObsidian server.

## Running locally

```bash
git clone --depth 1 https://github.com/Pushkinmazila2/webobsidian ../webobsidian
node scripts/build-capabilities.mjs --webobsidian ../webobsidian   # add --obsidian-api <checkout of obsidianmd/obsidian-api> to regenerate the API report
node scripts/generate.mjs --limit 50 --concurrency 8             # first 50 by popularity; omit --limit for everything
node --test test/*.test.mjs                                      # 29 tests, no network
```

Options of `generate.mjs`: `--budget-minutes N`, `--concurrency N`, `--force`, `--only id1,id2`, `--limit N`, `--out`, `--cache`, `--caps`.

## Output format

`community-plugins.json`:

```jsonc
{
  "schema": 1,
  "generatedAt": "2026-10-20T03:41:12.000Z",       // moves only when the content changes
  "capabilities": { "hash": "cbd9573da332", "api": "1.12.7", "dts": "1.14.4" },
  "totals": { "full": 0, "partial": 0, "broken": 0, "unknown": 0 },
  "plugins": [{
    "id": "dataview", "name": "Dataview", "author": "Michael Brenan", "description": "…", "repo": "blacksmithgu/obsidian-dataview",
    "version": "0.5.68", "minAppVersion": "0.13.11", "desktopOnly": true,   // from the release manifest (optional)
    "downloads": 5159754,                                                   // from Obsidian's stats file (optional)
    "compat": "partial",
    "reasons": ["Uses Obsidian API missing in WebObsidian: …"],              // why it is not "full"
    "flags": ["eval"]                                                       // facts that do not change the rating
  }]
}
```
