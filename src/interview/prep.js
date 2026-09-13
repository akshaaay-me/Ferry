import { q } from '../db.js';
import { chatJSON, setting } from '../llm.js';
import { loadProfile } from '../config.js';

const SYSTEM = `You help a candidate prepare for an interview for one specific job posting.

HARD RULE: you may only draw on stories from the supplied inventory. For each story you use you must
return its exact "id" from the inventory. You may pick which stories best answer which likely
interview question, and you may reframe or compress a story's wording to match the posting's
language - but you may NOT invent a situation, action, metric, or result that isn't already written
in that story's fields. If a likely question has no matching story in the inventory, say so in
"gaps" instead of fabricating one.

Return ONLY JSON:
{
  "likely_questions": ["4-6 questions this posting will probably ask, given its stated requirements"],
  "story_matches": [
    { "id": "st1", "question": "which likely_questions entry this answers", "angle": "how to frame/open the answer for this posting, grounded only in that story's fields" }
  ],
  "gaps": ["likely question types this candidate has no inventory story for - be specific"],
  "questions_to_ask": ["2-3 questions the candidate could ask the interviewer, grounded in the actual posting"]
}`;

/** Reject any story the model didn't actually take from the inventory. */
function validate(selection, profile) {
  const valid = new Set((profile.stories || []).map((s) => s.id));
  const bad = [];
  selection.story_matches = (selection.story_matches || []).filter((m) => {
    if (valid.has(m.id)) return true;
    bad.push(m.id ?? '(missing id)');
    return false;
  });
  return { selection, dropped: bad };
}

export async function prepInterview(jobId) {
  const profile = await loadProfile();
  const { rows } = await q(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  if (!rows.length) throw new Error(`no job with id ${jobId}`);
  const job = rows[0];

  if (!profile.stories?.length) {
    throw new Error('profile.json has no stories[] yet - add at least one before running prep');
  }

  const inventory = profile.stories.map((s) => ({
    id: s.id, prompt: s.prompt, situation: s.situation, task: s.task, action: s.action, result: s.result, tags: s.tags,
  }));

  const raw = await chatJSON({
    model: (await setting('tailor_model', 'TAILOR_MODEL')) || undefined,
    system: SYSTEM,
    maxTokens: 1800,
    messages: [{
      role: 'user',
      content: `STORY INVENTORY (the only facts you may use)\n${JSON.stringify(inventory, null, 2)}\n\n---\n\nJOB POSTING\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location || 'n/a'}\n\n${(job.description || '').slice(0, 12000)}`,
    }],
  });

  const { selection, dropped } = validate(raw, profile);
  if (dropped.length) console.warn(`  dropped ${dropped.length} unsourced story ref(s): ${dropped.join(', ')}`);

  await q(`INSERT INTO interview_preps (job_id, selection) VALUES ($1, $2)`, [jobId, JSON.stringify(selection)]);
  return { job, selection, dropped };
}
