import { q } from '../db.js';
import { chatJSON, setting } from '../llm.js';
import { loadProfile } from '../config.js';

const SYSTEM = `You tailor a resume for one specific job posting.

HARD RULE: you may only use bullets from the supplied inventory. For each bullet you include you must return its exact "id" from the inventory, plus a rewritten version of that bullet. The rewrite may reorder, compress, or change vocabulary to match the posting's language. It may NOT introduce facts, technologies, metrics, employers, or achievements that are absent from the source bullet. If the job asks for something the candidate has not done, leave it out — do not invent it.

Return ONLY JSON:
{
  "headline": "role title to put under the name, aligned to the posting",
  "summary": "2-3 sentence positioning statement, grounded only in inventory facts",
  "experience": [
    { "company": "...", "role": "...", "bullets": [ { "id": "fp1", "text": "rewritten bullet" } ] }
  ],
  "projects": [ { "id": "pr1", "name": "...", "text": "rewritten one-liner" } ],
  "skills": { "Group name": ["ordered", "most relevant first"] },
  "omitted": ["ids you deliberately left out and why, briefly"],
  "cover_note": "short paragraph the candidate can paste into an application form"
}

Aim for 4-6 experience bullets and 2-3 projects. Order everything by relevance to the posting.`;

/** Reject any bullet the model didn't actually take from the inventory. */
function validate(selection, profile) {
  const valid = new Set([
    ...profile.experience.flatMap((e) => e.bullets.map((b) => b.id)),
    ...profile.projects.map((p) => p.id),
  ]);
  const bad = [];

  for (const exp of selection.experience || []) {
    exp.bullets = (exp.bullets || []).filter((b) => {
      if (valid.has(b.id)) return true;
      bad.push(b.id ?? '(missing id)');
      return false;
    });
  }
  selection.projects = (selection.projects || []).filter((p) => {
    if (valid.has(p.id)) return true;
    bad.push(p.id ?? '(missing id)');
    return false;
  });

  return { selection, dropped: bad };
}

export async function tailor(jobId) {
  const profile = await loadProfile();
  const { rows } = await q(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  if (!rows.length) throw new Error(`no job with id ${jobId}`);
  const job = rows[0];

  const inventory = {
    experience: profile.experience.map((e) => ({
      company: e.company, role: e.role, start: e.start, end: e.end,
      bullets: e.bullets.map((b) => ({ id: b.id, text: b.text, tags: b.tags })),
    })),
    projects: profile.projects,
    skills: profile.skills,
  };

  const raw = await chatJSON({
    model: (await setting('tailor_model', 'TAILOR_MODEL')) || undefined,
    system: SYSTEM,
    maxTokens: 2500,
    messages: [{
      role: 'user',
      content: `BULLET INVENTORY (the only facts you may use)\n${JSON.stringify(inventory, null, 2)}\n\n---\n\nJOB POSTING\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location || 'n/a'}\n\n${(job.description || '').slice(0, 12000)}`,
    }],
  });

  const { selection, dropped } = validate(raw, profile);
  if (dropped.length) console.warn(`  dropped ${dropped.length} unsourced bullet(s): ${dropped.join(', ')}`);

  await q(`INSERT INTO resumes (job_id, selection) VALUES ($1, $2)`, [jobId, JSON.stringify(selection)]);
  return { job, selection, dropped };
}
