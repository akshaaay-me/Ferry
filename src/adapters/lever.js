import { getJSON, stripHtml, isRemote } from '../util.js';

export const name = 'lever';
export const detect = (html) => html.match(/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i)?.[1];

export async function fetchJobs({ slug, name: company }) {
  const data = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(data)) return [];
  return data.map((j) => ({
    source: 'lever',
    source_job_id: String(j.id),
    company: company || slug,
    title: j.text,
    location: j.categories?.location || null,
    remote: isRemote(`${j.categories?.location} ${j.workplaceType} ${j.text}`),
    department: j.categories?.team || j.categories?.department || null,
    salary: j.salaryRange ? `${j.salaryRange.min}-${j.salaryRange.max} ${j.salaryRange.currency}` : null,
    url: j.hostedUrl,
    description: j.descriptionPlain || stripHtml(j.description || ''),
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}
