import { getJSON, stripHtml, mapLimit, isRemote } from '../util.js';

/**
 * Workday ("CXS") — the ATS the embedded hardware industry actually runs on:
 * NXP, Analog Devices, TI, Bosch, Continental, Qualcomm, Honeywell, Siemens,
 * Micron, Western Digital, Garmin. All of them staff large Bengaluru / Hyderabad /
 * Noida / Pune engineering sites, and none of them were reachable before this file.
 *
 * Keyless, no auth, no bot wall — the same first-party endpoint the company's own
 * careers page calls to render itself. Two calls per job board:
 *   POST /wday/cxs/{tenant}/{site}/jobs      -> { total, jobPostings: [{ title, externalPath, ... }] }
 *   GET  /wday/cxs/{tenant}/{site}{path}     -> { jobPostingInfo: { jobDescription, location, ... } }
 *
 * Unlike every other adapter here, `searchText` filters SERVER-side, so this pulls
 * ~76 embedded roles rather than 2000 of everything and then throwing 97% away.
 *
 * A tenant is addressed as `tenant:host:site` (e.g. `nxp:wd3:careers`) because the
 * host shard and the site name are both per-customer and neither is derivable from
 * the other. `detect()` below reads all three off a careers page, so `discover:bulk`
 * grows this list on its own.
 */
export const name = 'workday';

const PAGE = 20;   // Workday's own page size; it caps `limit` at 20 regardless.

// Site names are per-tenant, but `wday` is the API path itself, never a site.
export const detect = (html) => {
  const m = html.match(
    /([a-z0-9][a-z0-9-]*)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/
  );
  if (!m || m[3] === 'wday') return undefined;
  return `${m[1]}:${m[2]}:${m[3]}`;
};

function parseSlug(slug) {
  const [tenant, host, site] = String(slug).split(':');
  if (!tenant || !host || !site) {
    throw new Error(`workday slug must be "tenant:host:site" (e.g. nxp:wd3:careers), got "${slug}"`);
  }
  return { tenant, host, site };
}

export async function fetchJobs({ slug, name: company }) {
  const { tenant, host, site } = parseSlug(slug);
  const base = `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
  const searchText = process.env.WORKDAY_QUERY || 'embedded firmware';
  const maxPages = Number(process.env.WORKDAY_PAGES || 2);

  // 1. Paginate the listing. It carries no JD body — only title + externalPath.
  const postings = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await getJSON(`${base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset: page * PAGE, searchText }),
    });
    const batch = data?.jobPostings || [];
    postings.push(...batch);
    if (batch.length < PAGE || postings.length >= (data?.total ?? 0)) break;
  }

  // 2. Pull each JD. Same shape as smartrecruiters.js, same reason: the listing
  //    omits the body, and the body is what the prefilter and the LLM actually read.
  const jobs = await mapLimit(postings, 4, async (p) => {
    const detail = await getJSON(`${base}${p.externalPath}`).catch(() => null);
    const info = detail?.jobPostingInfo;
    const location = [info?.location, ...(info?.additionalLocations || [])]
      .filter(Boolean).join('; ') || p.locationsText || null;
    const title = info?.title || p.title;

    return {
      source: 'workday',
      source_job_id: String(info?.jobPostingId || info?.jobReqId || p.externalPath),
      company: company || tenant,
      title,
      location,
      remote: isRemote(`${location} ${title} ${info?.timeType || ''}`),
      department: null,
      salary: null,
      // externalUrl is the public apply page; the cxs path above is the API mirror.
      url: info?.externalUrl
        || `https://${tenant}.${host}.myworkdayjobs.com/${site}${p.externalPath}`,
      // No detail (rate limit, transient 5xx) still yields a usable row: title and
      // location alone clear the title half of the prefilter, and the next cycle retries.
      description: stripHtml(info?.jobDescription || '') || `${title} — ${location || ''}`,
      posted_at: info?.startDate || null,
    };
  });

  return jobs.filter((j) => j && j.title && j.url);
}
