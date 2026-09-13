import { getJSON, stripHtml, isRemote } from '../util.js';

export const name = 'recruitee';
export const detect = (html) => html.match(/([a-z0-9_-]+)\.recruitee\.com/i)?.[1];

export async function fetchJobs({ slug, name: company }) {
  const data = await getJSON(`https://${slug}.recruitee.com/api/offers/`);
  if (!data?.offers) return [];
  return data.offers.map((j) => ({
    source: 'recruitee',
    source_job_id: String(j.id),
    company: company || slug,
    title: j.title,
    location: j.location || [j.city, j.country].filter(Boolean).join(', ') || null,
    remote: isRemote(`${j.location} ${j.remote} ${j.title}`),
    department: j.department || null,
    salary: null,
    url: j.careers_url || j.careers_apply_url,
    description: stripHtml(`${j.description || ''}\n${j.requirements || ''}`),
    posted_at: j.published_at || null,
  }));
}
