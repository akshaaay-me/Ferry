import { getText } from '../util.js';
import { detectors } from '../adapters/index.js';
import { q } from '../db.js';

const CANDIDATE_PATHS = ['/careers', '/careers/', '/jobs', '/company/careers', '/about/careers', '/join-us', '/'];

// Structural path segments that a loose detect regex can capture instead of the real
// slug. Storing one produces a company row that fetches nothing on every cycle, forever,
// and looks identical to "this company has no openings". Belt and braces alongside the
// per-adapter regex fixes - a bad regex in a future adapter can't poison the table.
const JUNK_SLUGS = new Set(['embed', 'job_board', 'js', 'jobs', 'boards', 'job-boards',
  'careers', 'api', 'www', 'search', 'embed.js']);

/**
 * Given a company domain, find which ATS it publishes through and what slug it uses.
 * This is how the target list grows past whatever you seeded by hand.
 */
export async function detectAts(domain) {
  const base = domain.startsWith('http') ? domain : `https://${domain}`;
  for (const path of CANDIDATE_PATHS) {
    let html;
    try { html = await getText(new URL(path, base).toString()); }
    catch { continue; }

    for (const adapter of detectors) {
      const slug = adapter.detect(html);
      if (slug && !JUNK_SLUGS.has(slug.toLowerCase())) {
        return { ats: adapter.name, slug, careers_url: new URL(path, base).toString() };
      }
    }
  }
  return null;
}

export async function discoverAndSave(domain, name) {
  const found = await detectAts(domain);
  if (!found) return null;
  await q(
    `INSERT INTO companies (name, ats, slug, careers_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ats, slug) DO UPDATE SET careers_url = EXCLUDED.careers_url`,
    [name || domain.replace(/^https?:\/\//, '').split('/')[0], found.ats, found.slug, found.careers_url]
  );
  return found;
}
