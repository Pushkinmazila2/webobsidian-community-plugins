/**
 * Small network helpers: polite fetching (retry with backoff, size cap, timeout) and a worker pool with a deadline.
 * Node 20+ only (global fetch), no dependencies. `fetch` and `sleep` are injectable so tests never touch the network.
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a URL as text.
 * @returns {Promise<{ status: number, text?: string, etag?: string, tooLarge?: boolean }>}
 *   status 200 → text set · 404/410 → not there · 413 → tooLarge · anything else after the retries → thrown error
 */
export async function fetchText(url, opts = {}) {
  const { retries = 3, timeoutMs = 30_000, maxBytes = 25 * 1048576, headers = {}, fetchImpl = fetch, sleep = defaultSleep } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'user-agent': 'webobsidian-community-plugins', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (res.status === 404 || res.status === 410) return { status: res.status };
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        // 403 on raw.githubusercontent.com / github.com is how secondary rate limits show up
        const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt + Math.random() * 500;
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        await res.body?.cancel().catch(() => {});
        if (attempt < retries) { await sleep(Math.min(wait, 60_000)); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const declared = Number(res.headers.get('content-length'));
      if (declared > maxBytes) { await res.body?.cancel().catch(() => {}); return { status: 413, tooLarge: true }; }
      const text = await readCapped(res, maxBytes);
      if (text === null) return { status: 413, tooLarge: true };
      return { status: 200, text, etag: res.headers.get('etag') ?? undefined };
    } catch (e) {
      lastErr = e;
      if (e?.message?.startsWith('HTTP ')) throw e; // already retried above
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

async function readCapped(res, maxBytes) {
  if (!res.body) return await res.text();
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > maxBytes) { await res.body.cancel?.().catch?.(() => {}); return null; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Run fn over items with at most `concurrency` in flight; stop starting new ones once `deadline` (ms epoch) passes.
 * @returns {Promise<{ done: number, skipped: number }>} skipped = items never started because of the deadline
 */
export async function pool(items, concurrency, fn, { deadline = Infinity, now = Date.now } = {}) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      if (now() >= deadline) return;
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
      done++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return { done, skipped: items.length - Math.min(next, items.length) };
}
