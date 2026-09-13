import { q } from '../db.js';
import { loadProfile } from '../config.js';

const has = (haystack, needle) => haystack.includes(needle.toLowerCase());

/**
 * Stage 1: deterministic, free, runs on everything.
 * Its only job is to get thousands of rows down to something an LLM can afford to read.
 */
export function scoreJob(job, match) {
  const title = (job.title || '').toLowerCase();
  const loc = (job.location || '').toLowerCase();
  const body = `${title}\n${(job.description || '').toLowerCase().slice(0, 6000)}`;

  // include_titles is scoped to the embedded family, so a title that matches it is
  // in-domain by definition. Check it FIRST: the exclude lists are raw substrings
  // ("ml engineer", "solutions architect", "support engineer") and would otherwise
  // hard-zero exactly the roles this search exists to find - "Embedded ML Engineer",
  // "IoT Solutions Architect". Seniority is likewise not a kill for an in-domain role;
  // score.js says so explicitly, and the two stages used to contradict each other.
  const titleHit = match.include_titles.some((t) => has(title, t));

  if (match.exclude_companies?.some((c) => has((job.company || '').toLowerCase(), c)))
    return { score: 0, reason: 'excluded company' };
  const tooSenior = match.exclude_seniority?.some((t) => has(title, t)) ?? false;
  if (!titleHit) {
    if (match.exclude_titles.some((t) => has(title, t))) return { score: 0, reason: 'excluded title' };
    if (tooSenior) return { score: 0, reason: 'seniority mismatch' };
  }

  const locOk = !loc
    || job.remote && match.remote_ok
    || match.locations.some((l) => has(loc, l));

  let kw = 0, max = 0;
  for (const [word, weight] of Object.entries(match.keywords)) {
    max += weight;
    if (body.includes(word.toLowerCase())) kw += weight;
  }

  // Title relevance is worth as much as the whole keyword basket.
  // A location mismatch is a soft penalty, not a kill - onsite-abroad roles
  // still reach the LLM and the dashboard, just ranked lower. The LLM's
  // location_fit dimension carries the real judgment. Tune match.off_location_penalty
  // in profile.json (higher = more international roles surface).
  const raw = (titleHit ? 0.5 : 0) + 0.5 * Math.min(1, kw / (max * 0.18));
  // Two soft penalties, same shape: rank it down, never kill it. An in-domain
  // senior/staff/principal role stays visible (score.js grades the stretch properly,
  // with the full JD), but it must not crowd the 40-row LLM budget out from under the
  // junior and mid roles - senior JDs are keyword-dense and otherwise sweep the top.
  // Tune both in profile.json: higher = more of that kind surfaces.
  let score = locOk ? raw : raw * (match.off_location_penalty ?? 0.75);
  if (tooSenior) score *= match.seniority_penalty ?? 0.6;
  return {
    score: Number(score.toFixed(3)),
    reason: (titleHit ? 'title+keywords' : 'keywords only')
      + (locOk ? '' : ', off-location') + (tooSenior ? ', over-senior' : ''),
  };
}

/**
 * Stage 2 gate. `keep` caps how many rows the LLM reads per cycle (the cost lever);
 * `floor` is the absolute keyword_score below which a row isn't worth the LLM's time.
 *
 * Rows that clear the floor but don't fit under `keep` stay 'new' - a later cycle
 * with fewer competitors picks them up, instead of being killed forever by one
 * unlucky burst (HN "Who's Hiring" alone is 500+ rows). Only a hard 0 (excluded
 * title/company/seniority - deterministic, won't change) is rejected here; the rest
 * age out via the stale sweep below.
 */
/**
 * Partition scored rows into their next stage. Pure - the DB-touching wrapper is
 * `prefilter()` below; this is the bit worth testing (see prefilter.test.mjs).
 *   >= floor and within the top `keep`  -> 'prefiltered' (the LLM reads these)
 *   hard 0 (excluded title/co/seniority) -> 'rejected'   (deterministic, won't change)
 *   everything else                      -> 'new'        (retry next cycle)
 */
export function promote(scored, { keep = 40, floor = 0.35 } = {}) {
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const promotedIds = new Set(
    ranked.filter((s) => s.score >= floor).slice(0, keep).map((p) => p.id)
  );
  return ranked.map((s) => ({
    id: s.id,
    score: s.score,
    stage: promotedIds.has(s.id) ? 'prefiltered' : s.score === 0 ? 'rejected' : 'new',
  }));
}

export async function prefilter({ keep = 40, floor = 0.35, maxAgeDays = 21 } = {}) {
  const profile = await loadProfile();
  const { rows } = await q(
    `SELECT id, title, company, location, remote, description
     FROM jobs WHERE stage = 'new' AND closed_at IS NULL`
  );

  const scored = rows.map((j) => ({ id: j.id, ...scoreJob(j, profile.match) }));
  const next = promote(scored, { keep, floor });
  const promotedCount = next.filter((n) => n.stage === 'prefiltered').length;

  if (next.length) {
    await q(
      `UPDATE jobs SET keyword_score = d.score, stage = d.stage
       FROM unnest($1::int[], $2::real[], $3::text[]) AS d(id, score, stage)
       WHERE jobs.id = d.id`,
      [next.map((n) => n.id), next.map((n) => n.score), next.map((n) => n.stage)]
    );
  }

  // Cleared the floor too many times without ever making the cut: give up.
  const { rowCount: aged } = await q(
    `UPDATE jobs SET stage = 'rejected'
     WHERE stage = 'new' AND first_seen < now() - ($1 || ' days')::interval`,
    [String(maxAgeDays)]
  );

  return { considered: rows.length, promoted: promotedCount, aged_out: aged };
}
