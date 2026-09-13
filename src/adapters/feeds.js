import { getJSON, getText, stripHtml } from '../util.js';

/**
 * Open, keyless aggregator APIs. Broad coverage, lower signal than the ATS
 * endpoints, but they surface companies you'd never have in your slug list.
 */
export const name = 'feeds';

// --- We Work Remotely: public RSS, no key, no auth. WWR's own feed page asks
// only that consumers attribute links back to the site — the job `url` below
// always points at the original weworkremotely.com posting, so that holds.
function xmlUnescape(s = '') {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function xmlTag(block, tagName) {
  const m = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return m ? m[1].trim() : '';
}

function parseWeWorkRemotely(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((block) => {
    // WWR titles are conventionally "Company: Job Title".
    const rawTitle = xmlUnescape(xmlTag(block, 'title'));
    const splitAt = rawTitle.indexOf(':');
    const company = splitAt > -1 ? rawTitle.slice(0, splitAt).trim() : null;
    const title = splitAt > -1 ? rawTitle.slice(splitAt + 1).trim() : rawTitle;

    const region = xmlUnescape(xmlTag(block, 'region'));
    const country = xmlUnescape(xmlTag(block, 'country'));
    const state = xmlUnescape(xmlTag(block, 'state'));
    const location = region || [state, country].filter(Boolean).join(', ') || 'Remote';

    const description = stripHtml(xmlUnescape(xmlTag(block, 'description')));
    const url = xmlTag(block, 'link') || xmlTag(block, 'guid');
    const pubDate = xmlTag(block, 'pubDate');
    const posted = pubDate ? new Date(pubDate) : null;

    return {
      source: 'weworkremotely',
      source_job_id: url.split('/').filter(Boolean).pop() || url,
      company: company || 'Unknown',
      title,
      location,
      remote: true, // every WWR listing is remote by definition
      department: xmlUnescape(xmlTag(block, 'category')) || null,
      salary: description.match(/\$[\d,.]+k?\s*(?:-|–|to)\s*\$?[\d,.]+k?/i)?.[0] || null,
      url,
      description,
      posted_at: posted && !isNaN(posted) ? posted.toISOString() : null,
    };
  });
}

const FEEDS = {
  remotive: async () => {
    const d = await getJSON('https://remotive.com/api/remote-jobs?limit=200');
    return (d?.jobs || []).map((j) => ({
      source: 'remotive',
      source_job_id: String(j.id),
      company: j.company_name,
      title: j.title,
      location: j.candidate_required_location || 'Remote',
      remote: true,
      department: j.category || null,
      salary: j.salary || null,
      url: j.url,
      description: stripHtml(j.description || ''),
      posted_at: j.publication_date || null,
    }));
  },
  arbeitnow: async () => {
    const d = await getJSON('https://www.arbeitnow.com/api/job-board-api');
    return (d?.data || []).map((j) => ({
      source: 'arbeitnow',
      source_job_id: String(j.slug),
      company: j.company_name,
      title: j.title,
      location: j.location,
      remote: !!j.remote,
      department: (j.tags || [])[0] || null,
      salary: null,
      url: j.url,
      description: stripHtml(j.description || ''),
      posted_at: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
    }));
  },
  himalayas: async () => {
    const d = await getJSON('https://himalayas.app/jobs/api?limit=200');
    return (d?.jobs || []).map((j) => ({
      source: 'himalayas',
      source_job_id: String(j.guid || j.id),
      company: j.companyName,
      title: j.title,
      location: (j.locationRestrictions || []).join(', ') || 'Remote',
      remote: true,
      department: null,
      salary: j.minSalary ? `${j.minSalary}-${j.maxSalary} ${j.salaryCurrency || ''}` : null,
      url: j.applicationLink || j.guid,
      description: stripHtml(j.description || j.excerpt || ''),
      posted_at: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
    }));
  },
  weworkremotely: async () => {
    const xml = await getText('https://weworkremotely.com/remote-jobs.rss');
    return parseWeWorkRemotely(xml);
  },

  // The Muse: public jobs API, no key required (a key only raises the rate limit).
  // Full HTML JD, so it feeds the keyword prefilter real signal. No free-text
  // search on the public endpoint - filter by category and page through.
  themuse: async () => {
    const cats = (process.env.THEMUSE_CATEGORIES || 'Engineering,Data Science,Science and Engineering').split(',');
    const key = process.env.THEMUSE_API_KEY ? `&api_key=${process.env.THEMUSE_API_KEY}` : '';
    const out = [];
    for (const category of cats.map((c) => c.trim()).filter(Boolean)) {
      for (let page = 0; page < 3; page++) {
        const d = await getJSON(
          `https://www.themuse.com/api/public/jobs?page=${page}&category=${encodeURIComponent(category)}${key}`
        );
        for (const j of d?.results || []) {
          const locs = (j.locations || []).map((l) => l.name);
          out.push({
            source: 'themuse',
            source_job_id: String(j.id),
            company: j.company?.name || 'Unknown',
            title: j.name,
            location: locs.join('; ') || null,
            remote: locs.some((l) => /remote|flexible/i.test(l)),
            department: (j.categories || [])[0]?.name || null,
            salary: null,
            url: j.refs?.landing_page || `https://www.themuse.com/jobs/${j.id}`,
            description: stripHtml(j.contents || ''),
            posted_at: j.publication_date || null,
          });
        }
        if (!d || page + 1 >= (d.page_count || 0)) break;
      }
    }
    return out;
  },

  // RemoteOK: single keyless JSON call. Element 0 is a legal/metadata object, skip it.
  remoteok: async () => {
    const d = await getJSON('https://remoteok.com/api');
    return (Array.isArray(d) ? d : [])
      .filter((j) => j.id && j.position)
      .map((j) => ({
        source: 'remoteok',
        source_job_id: String(j.id),
        company: j.company || 'Unknown',
        title: j.position,
        location: j.location || 'Remote',
        remote: true,
        department: (j.tags || [])[0] || null,
        salary: j.salary_min ? `${j.salary_min}-${j.salary_max}` : null,
        url: j.url || j.apply_url,
        description: stripHtml(j.description || ''),
        posted_at: j.date || null,
      }));
  },

  // Adzuna: free key (developer.adzuna.com), 250 calls/day. The one source with
  // real Indian-market coverage - aggregates Naukri/Indeed-tier listings the ATS
  // adapters can't see. API descriptions are truncated: weaker prefilter signal.
  adzuna: async () => {
    const id = process.env.ADZUNA_APP_ID, key = process.env.ADZUNA_APP_KEY;
    if (!id || !key) throw new Error('ADZUNA_APP_ID / ADZUNA_APP_KEY not set (free key at developer.adzuna.com)');
    const country = process.env.ADZUNA_COUNTRY || 'in';
    const whatOr = process.env.ADZUNA_QUERY || 'embedded firmware tinyml "edge ai"';
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const d = await getJSON(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/${page}` +
        `?app_id=${id}&app_key=${key}&results_per_page=50&what_or=${encodeURIComponent(whatOr)}&content-type=application/json`
      );
      for (const j of d?.results || []) {
        out.push({
          source: 'adzuna',
          source_job_id: String(j.id),
          company: j.company?.display_name || 'Unknown',
          title: j.title,
          location: j.location?.display_name || null,
          remote: /remote/i.test(`${j.location?.display_name} ${j.title}`),
          department: j.category?.label || null,
          salary: j.salary_min ? `${Math.round(j.salary_min)}-${Math.round(j.salary_max || j.salary_min)}` : null,
          url: j.redirect_url,
          description: stripHtml(j.description || ''),
          posted_at: j.created || null,
        });
      }
      if (!d?.results?.length) break;
    }
    return out;
  },
};

export async function fetchJobs({ slug }) {
  const feed = FEEDS[slug];
  if (!feed) throw new Error(`unknown feed: ${slug}`);
  return await feed();
}

export const available = Object.keys(FEEDS);
