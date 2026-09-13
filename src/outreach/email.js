import { q } from '../db.js';
import { chatJSON, setting } from '../llm.js';
import { loadProfile } from '../config.js';

/**
 * Drafts a cold outreach email for a posting that has no apply form - the common
 * case for smaller Indian embedded companies, where "applying" means mailing HR.
 *
 * Same guardrail as src/resume/tailor.js: the model gets an inventory of facts and
 * may not go outside it. Nothing here sends mail. The draft goes to the UI, you
 * read it, and you send it from your own client.
 */
const SYSTEM = `You write one short cold-outreach email from a job seeker to a company about one specific posting.

HARD RULE: every claim about the candidate must come from the supplied CANDIDATE FACTS. Do not invent employers, technologies, metrics, years of experience, certifications or achievements. If the posting asks for something the candidate has not done, do not claim it — either leave it out or name it honestly as something they are keen to pick up.

Style: plain professional English, no marketing adjectives, no "I am writing to express my keen interest", no flattery about the company. 120-180 words. Three short paragraphs: who they are and which role they mean, two or three concrete reasons they fit this posting, one closing line offering the resume. Sign off with the candidate's name only.

Return ONLY JSON:
{
  "subject": "specific subject line naming the role",
  "body": "the email body, plain text, \\n between paragraphs",
  "used_ids": ["ids of the inventory bullets/projects you drew on"]
}`;

/**
 * Best guess at a recipient from the posting URL's host - always shown to you as a
 * guess to edit, never used to send anything. We do not scrape pages or use
 * email-finder services to dig up a named person's address.
 */
export function guessRecipient(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // ATS-hosted postings (boards.greenhouse.io, myworkdayjobs.com, ...) tell us
    // nothing about the employer's own mail domain, so don't pretend otherwise.
    const ats = /greenhouse|lever|ashby|workable|recruitee|smartrecruiters|myworkday|ycombinator|adzuna/i;
    return ats.test(host) ? '' : `careers@${host}`;
  } catch {
    return '';
  }
}

export async function draftEmail(jobId) {
  const profile = await loadProfile();
  const { rows } = await q(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  if (!rows.length) throw new Error(`no job with id ${jobId}`);
  const job = rows[0];

  const inventory = {
    basics: profile.basics,
    experience: profile.experience.map((e) => ({
      company: e.company, role: e.role, start: e.start, end: e.end,
      bullets: e.bullets.map((b) => ({ id: b.id, text: b.text })),
    })),
    projects: profile.projects.map((p) => ({ id: p.id, name: p.name, text: p.text })),
    skills: profile.skills,
  };

  const draft = await chatJSON({
    model: (await setting('tailor_model', 'TAILOR_MODEL')) || undefined,
    system: SYSTEM,
    maxTokens: 1200,
    messages: [{
      role: 'user',
      content: `CANDIDATE FACTS (the only facts you may use)\n${JSON.stringify(inventory, null, 2)}\n\n---\n\nJOB POSTING\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location || 'n/a'}\nURL: ${job.url}\n\n${(job.description || '').slice(0, 10000)}`,
    }],
  });

  return {
    job,
    to_suggestion: guessRecipient(job.url),
    subject: draft.subject || `${job.title} — ${profile.basics.name}`,
    body: draft.body || '',
  };
}
