import crypto from 'node:crypto';

const UA = 'job-agent/0.1 (personal job search; contact: you@example.com)';

/** GET with retry + backoff. Returns parsed JSON, or null on 404. */
export async function getJSON(url, { retries = 3, headers = {}, method = 'GET', body } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'user-agent': UA, accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(800 * 2 ** attempt + Math.random() * 400);
    }
  }
}

export async function getText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return await res.text();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run tasks with a concurrency cap. */
export async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (err) { out[idx] = { error: err.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// `= ''` only covers undefined; adapters (e.g. hn) can pass location: null explicitly.
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Cross-source dedup key. Same role posted to Greenhouse and an aggregator collapses to one. */
export function fingerprint({ company, title, location }) {
  return crypto
    .createHash('sha256')
    .update([norm(company), norm(title), norm(location).slice(0, 40)].join('|'))
    .digest('hex');
}

export function stripHtml(html = '') {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    // HN comments arrive with hex entities (&#x2F;) as well as decimal ones; without
    // this, titles render as "Senior Engineer (Python&#x2F;Django)" everywhere downstream.
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const isRemote = (text = '') => /\bremote\b|work from home|anywhere/i.test(text);
