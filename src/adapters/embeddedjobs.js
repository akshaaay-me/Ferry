import * as cheerio from 'cheerio';
import { getText, isRemote } from '../util.js';

/**
 * embedded.jobs (embedded systems / firmware / hardware niche board) has no
 * public API or feed, unlike every other adapter here. It's included anyway
 * because it's plain server-rendered HTML with no login wall and no visible
 * anti-bot layer - reading it is the same move the discovery crawler already
 * makes against a company's /careers page, just applied to a job board's own
 * listing page instead of one company's.
 *
 * Two honest limitations, given the "stay lightweight, don't fight the site"
 * rule: this only reads the single listing page below (whatever recent slice
 * it returns), not the full history behind it or every paginated page, and
 * it does not follow each job into its detail page, so `description` here is
 * a short synthesized summary, not the full JD. Running on a schedule means
 * the recent slice it does see is enough to catch new roles over time - but
 * this source will feed the keyword prefilter weaker signal than the ATS
 * adapters do. Markup here is unofficial and will drift; re-check the
 * heuristics below if this adapter stops returning jobs.
 */
export const name = 'embeddedjobs';

const RE_LOCATION = /📍/;
const RE_LEVEL = /📊/;
const RE_TYPE = /⏱/;
// Emoji glyphs are often followed by a zero-width variation selector or
// joiner; strip those too so the text after them doesn't carry a stray
// invisible character.
const stripMarker = (line, re) => line.replace(re, '').replace(/^[\s\uFE00-\uFE0F\u200D]+/, '').trim();

function parseCard($, anchorEl) {
  // Climb from the job's <a href="/job/..."> up to whichever ancestor block
  // actually holds this card's text (title, "@ company", location, ...) -
  // markup nesting isn't documented, so this looks for the ancestor whose
  // text has both a "@ company" line and a location line rather than
  // assuming a fixed depth or class name.
  let card = $(anchorEl);
  for (let i = 0; i < 5; i++) {
    const text = card.text();
    if (/@\s*\S/.test(text) && (RE_LOCATION.test(text) || /remote/i.test(text))) break;
    const parent = card.parent();
    if (!parent.length) break;
    card = parent;
  }

  const lines = card.text().split('\n').map((l) => l.trim()).filter(Boolean);
  const title = card.find('h3').first().text().trim() || lines.find((l) => l !== 'View') || null;

  let company = null, location = null, level = null, type = null;
  const extras = [];
  for (const line of lines) {
    if (line === title || line === 'View') continue;
    if (line.startsWith('@')) company = line.replace(/^@\s*/, '').trim();
    else if (RE_LOCATION.test(line)) location = stripMarker(line, RE_LOCATION);
    else if (RE_LEVEL.test(line)) level = stripMarker(line, RE_LEVEL);
    else if (RE_TYPE.test(line)) type = stripMarker(line, RE_TYPE);
    else extras.push(line);
  }

  if (!title || !company) return null;

  const description = [title, `@ ${company}`, location, level, type, ...extras]
    .filter(Boolean).join(' | ');

  return { title, company, location, level, type, description };
}

export async function fetchJobs() {
  const html = await getText('https://embedded.jobs/jobs');
  const $ = cheerio.load(html);
  const seen = new Set();
  const jobs = [];

  $('a[href*="/job/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = href.startsWith('http') ? href : new URL(href, 'https://embedded.jobs').href;
    if (seen.has(url)) return;
    seen.add(url);

    const parsed = parseCard($, el);
    if (!parsed) return;

    jobs.push({
      source: 'embeddedjobs',
      source_job_id: url.split('/').filter(Boolean).pop() || url,
      company: parsed.company,
      title: parsed.title,
      location: parsed.location || null,
      remote: isRemote(`${parsed.location} ${parsed.title}`),
      department: parsed.level || null,
      salary: null,
      url,
      description: parsed.description,
      posted_at: null,
    });
  });

  return jobs;
}
