import { getJSON, stripHtml, isRemote } from '../util.js';

export const name = 'greenhouse';
// The JS embed form is `embed/job_board/js?for=<slug>`, not `embed/job_board?for=<slug>`.
// Without the optional `/js` the prefix failed to match, the optional group was skipped,
// and the capture landed on the literal path segment "embed" - which then got stored as
// a company slug that fetches nothing, forever. (netradyne.com hit exactly this.)
export const detect = (html) =>
  html.match(/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/i)?.[1];

export async function fetchJobs({ slug, name: company }) {
  const data = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  if (!data?.jobs) return [];
  return data.jobs.map((j) => {
    const description = stripHtml(j.content || '');
    return {
      source: 'greenhouse',
      source_job_id: String(j.id),
      company: company || slug,
      title: j.title,
      location: j.location?.name || null,
      remote: isRemote(`${j.location?.name} ${j.title}`),
      department: j.departments?.[0]?.name || null,
      salary: null,
      url: j.absolute_url,
      description,
      posted_at: j.updated_at || j.first_published || null,
    };
  });
}
