import { getJSON, stripHtml } from '../util.js';

/**
 * Hacker News "Ask HN: Who is hiring?" — one of the highest signal-to-noise
 * sources for small companies that never post to any aggregator.
 * Top-level comments are the postings; the convention is:
 *   Company | Location | Role | REMOTE | url
 */
export const name = 'hn';

async function latestThreadId() {
  const res = await getJSON(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10'
  );
  // Match the monthly "Ask HN: Who is hiring? (Month Year)" thread, not the
  // "Who wants to be hired?" or "Freelancer? Seeking freelancer?" companions.
  const hit = res?.hits?.find(
    (h) => /who is hiring/i.test(h.title || '') && !/freelancer|wants to be hired/i.test(h.title || '')
  );
  return hit?.objectID || null;
}

function parseHeader(text) {
  const first = text.split('\n')[0].slice(0, 200);
  const parts = first.split(/\s*[|·]\s*|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  return {
    company: parts[0] || 'Unknown',
    // Heuristic: the location is usually the first segment that looks like a place.
    // The [A-Z]{2} arm is for US state codes (CA, NY, TX) and must stay case-SENSITIVE:
    // under /i it matched the last two letters of any word, so "Firmware Engineer" was
    // read as a location and every HN row got a garbage one.
    location: parts.slice(1).find(
      (p) => /,|(?:remote|onsite|hybrid)/i.test(p) || /[A-Z]{2}$/.test(p)) || null,
    title: parts.slice(1).find((p) => /engineer|developer|scientist|manager|lead|designer|devops|firmware|embedded/i.test(p))
           || parts[1] || first,
  };
}

export async function fetchJobs() {
  const threadId = await latestThreadId();
  if (!threadId) return [];
  const thread = await getJSON(`https://hn.algolia.com/api/v1/items/${threadId}`);
  const comments = (thread?.children || []).filter((c) => c.text && !c.deleted);

  return comments.map((c) => {
    const text = stripHtml(c.text);
    const { company, location, title } = parseHeader(text);
    const hnUrl = `https://news.ycombinator.com/item?id=${c.id}`;
    // The comment body carries the real apply link; prefer it, but skip bare
    // domains and non-apply links (blogs, twitter). Fall back to the HN thread,
    // which always has the poster's apply instructions.
    const applyUrl = (text.match(/https?:\/\/[^\s)>\]]+/g) || [])
      .find((u) => !/twitter\.com|x\.com|linkedin\.com\/in\/|github\.com\/[^/]+\/?$/i.test(u));
    return {
      source: 'hn',
      source_job_id: String(c.id),
      company,
      title,
      location,
      remote: /\bremote\b/i.test(text),
      department: null,
      salary: text.match(/\$[\d,.]+\s*[-–]\s*\$?[\d,.]+k?/i)?.[0] || null,
      url: applyUrl || hnUrl,
      description: `${text}\n\n---\nHN thread: ${hnUrl}`,
      posted_at: c.created_at || null,
    };
  });
}
