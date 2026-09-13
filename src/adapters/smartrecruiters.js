import { getJSON, stripHtml, mapLimit, isRemote } from '../util.js';

export const name = 'smartrecruiters';
export const detect = (html) => html.match(/careers\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/)?.[1];

export async function fetchJobs({ slug, name: company }) {
  const data = await getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`);
  if (!data?.content) return [];

  // Listings omit the body, so pull detail for each posting (capped concurrency).
  return await mapLimit(data.content, 4, async (j) => {
    const detail = await getJSON(
      `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${j.id}`
    ).catch(() => null);
    const sections = detail?.jobAd?.sections || {};
    const description = stripHtml(
      [sections.companyDescription, sections.jobDescription, sections.qualifications]
        .map((s) => s?.text).filter(Boolean).join('\n')
    );
    const loc = [j.location?.city, j.location?.country].filter(Boolean).join(', ');
    return {
      source: 'smartrecruiters',
      source_job_id: String(j.id),
      company: company || slug,
      title: j.name,
      location: loc || null,
      remote: j.location?.remote ?? isRemote(`${loc} ${j.name}`),
      department: j.department?.label || null,
      salary: null,
      url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      description,
      posted_at: j.releasedDate || null,
    };
  });
}
