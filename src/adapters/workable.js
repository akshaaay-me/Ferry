import { getJSON, stripHtml, isRemote } from '../util.js';

export const name = 'workable';
export const detect = (html) => html.match(/apply\.workable\.com\/([a-z0-9_-]+)/i)?.[1];

export async function fetchJobs({ slug, name: company }) {
  const data = await getJSON(`https://apply.workable.com/api/v3/accounts/${slug}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '', location: [], department: [] }),
  });
  const rows = data?.results || data?.jobs || [];
  return rows.map((j) => {
    const loc = [j.location?.city, j.location?.country].filter(Boolean).join(', ');
    return {
      source: 'workable',
      source_job_id: String(j.shortcode || j.id),
      company: company || slug,
      title: j.title,
      location: loc || null,
      remote: j.remote ?? isRemote(`${loc} ${j.title}`),
      department: j.department?.[0] || null,
      salary: null,
      url: `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
      description: stripHtml(j.description || ''),
      posted_at: j.published_on || j.created_at || null,
    };
  });
}
