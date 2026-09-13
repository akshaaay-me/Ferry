import { getJSON, stripHtml, isRemote } from '../util.js';

export const name = 'ashby';
export const detect = (html) => html.match(/jobs\.ashbyhq\.com\/([a-zA-Z0-9._-]+)/)?.[1];

export async function fetchJobs({ slug, name: company }) {
  const data = await getJSON(
    `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`
  );
  if (!data?.jobs) return [];
  return data.jobs.map((j) => ({
    source: 'ashby',
    source_job_id: String(j.id),
    company: company || data.name || slug,
    title: j.title,
    location: j.location || null,
    remote: j.isRemote ?? isRemote(`${j.location} ${j.title}`),
    department: j.department || j.team || null,
    salary: j.compensation?.compensationTierSummary || null,
    url: j.jobUrl || j.applyUrl,
    description: j.descriptionPlain || stripHtml(j.descriptionHtml || ''),
    posted_at: j.publishedAt || null,
  }));
}
