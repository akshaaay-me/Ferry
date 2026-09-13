import { q } from '../db.js';
import { chatJSON, setting } from '../llm.js';
import { mapLimit } from '../util.js';
import { loadProfile } from '../config.js';

const SYSTEM = `You screen job postings for one specific engineer: an early-career EMBEDDED / firmware engineer moving toward embedded AI / edge AI.

DOMAIN RULE - this is the most important instruction:
The candidate wants the embedded family, broadly. Treat ALL of these as in-domain and score them GENEROUSLY, even on partial overlap:
  firmware, embedded software, embedded systems, embedded Linux, RTOS / FreeRTOS / Zephyr, bare-metal,
  device drivers / BSP / board bring-up, bootloaders, microcontroller (STM32 / ESP32 / ARM Cortex-M / PIC / MSP430 / nRF),
  IoT devices, wearables, automotive embedded (AUTOSAR / CAN / MISRA), robotics firmware, hardware-adjacent software,
  sensors / signal processing, edge ML / TinyML / on-device inference.
For an in-domain role: a seniority gap (posting says "senior" / "lead" / "3-5 years") or a foreign location lowers the
relevant DIMENSION but must NOT collapse the overall "score". A solid embedded-family role still lands 0.6-0.85 even if
the candidate would be stretching. Missing one specific chip or RTOS they haven't touched is a normal, learnable gap - not
a disqualifier. Err on the side of showing these to the human.

Score LOW (below 0.4) only when the role is genuinely OUTSIDE embedded: pure web / frontend / backend / full-stack, data
engineering / data science / analytics, cloud / DevOps / SRE / platform, mobile app development, pre-sales / solutions
architecture, IT support, management-only. These are not near-misses, they are the wrong field - be blunt.

Do not inflate scores to be encouraging, but do not be harsh on embedded roles for seniority or location alone.

HARD EXPERIENCE GATE: the candidate has ~1.5 years of professional experience. Read the posting for a firm
minimum years-of-experience requirement. Set "hard_experience_req" to that number (e.g. "3+ years" -> 3,
"minimum of 5 years" -> 5, "5-7 years" -> 5, "2+ years" -> 2). Set it to null if the posting gives no
explicit number - a bare "Senior" / "Lead" / "experienced" label with NO number is null, not a guess.
The pipeline uses this to rank, not to reject - a 3-year ask is routinely won by this candidate - so fill
the field honestly and let "score" carry your real judgment.

Return ONLY a JSON object:
{
  "score": 0.0-1.0,
  "verdict": "one sentence, plain language",
  "hard_experience_req": <integer years the posting explicitly demands, or null>,
  "why_fit": ["concrete overlap with the candidate's actual experience"],
  "gaps": ["what the posting asks for that the candidate does not have"],
  "resume_angle": "which parts of the candidate's background to lead with, one sentence",
  "seniority_fit": "under | match | over",
  "flags": ["contract", "relocation required", "vague jd", "unpaid", ...],
  "dimensions": {
    "skill_fit": 1-5 (embedded-domain overlap; rate the FAMILY, not exact chip/RTOS match - 5 = squarely embedded, 1 = not embedded at all),
    "seniority_fit": 1-5 (does the level asked for match ~1-2 yrs experience, 5 = exact match; a stretch is 2-3, not 1),
    "location_fit": 1-5 (see the location note below),
    "growth_fit": 1-5 (does this move them toward embedded AI / edge AI, their stated direction)
  }
}

"score" stays the single number everything else (thresholds, sorting, notifications) keys off - it
should reflect your overall holistic judgment, not a mechanical average of the dimensions above.
"dimensions" exists purely so a human glancing at the job list can see *why* a score landed where it
did, at a finer grain than one number - rate each 1-5, 5 being an excellent match on that axis alone.

Location: the candidate is based in Bengaluru and prefers roles there or fully remote. They are,
however, open to relocating internationally for a clearly excellent opportunity - strong embedded-AI /
edge-AI fit at a good company. So: rate "location_fit" honestly (Bengaluru/remote = 5, elsewhere = low),
but do NOT drag the overall "score" down to "skip" for an otherwise-excellent role purely because it is
abroad. A great role abroad can still land at 0.7-0.85; a mediocre role abroad is still a skip. Add
"relocation required" to flags when relevant.

Scoring guide: 0.9+ drop everything and apply. 0.75-0.9 strong embedded fit, tailored application. 0.55-0.75 solid embedded role, worth a look even if a stretch on seniority or location. 0.4-0.55 embedded-adjacent but weak. Below 0.4 = outside embedded, skip.`;

function profileDigest(p) {
  const bullets = [
    ...p.experience.flatMap((e) => e.bullets.map((b) => `${e.role} @ ${e.company}: ${b.text}`)),
    ...p.projects.map((pr) => `${pr.name}: ${pr.text}`),
  ];
  return `Location: ${p.basics.location}\nWork preference: ${p.basics.work_preference || 'Bengaluru or remote; open to relocation for a strong role'}\nHeadline: ${p.basics.headline}\nSkills: ${JSON.stringify(p.skills)}\n\nExperience:\n- ${bullets.join('\n- ')}`;
}

const MAX_ATTEMPTS = 3;

export async function scoreAll({ concurrency = 4, threshold = 0.65 } = {}) {
  const profile = await loadProfile();
  const digest = profileDigest(profile);
  const model = (await setting('score_model', 'SCORE_MODEL')) || undefined;   // else falls back to ANTHROPIC_MODEL / LLM_MODEL
  const { rows } = await q(
    `SELECT id, company, title, location, remote, salary, url, description, score_attempts
     FROM jobs WHERE stage = 'prefiltered' AND score_attempts < $1 ORDER BY keyword_score DESC`,
    [MAX_ATTEMPTS]
  );

  // An auth/quota failure is a GLOBAL config problem, not a per-job one. Left to the
  // normal retry path it burns every row's 3 attempts and marks the entire queue
  // 'rejected' within three cycles - a bad API key would quietly destroy the backlog.
  // Detect it once, stop the pass, and leave score_attempts untouched.
  let fatal = null;
  const isFatal = (msg) => /(401|403)|authentication|invalid x-api-key|credit balance|permission/i.test(msg);

  await mapLimit(rows, concurrency, async (job) => {
    if (fatal) return;
    const jd = `Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'unspecified'}${job.remote ? ' (remote)' : ''}
Salary: ${job.salary || 'not stated'}

${(job.description || '').slice(0, 8000)}`;

    try {
      const v = await chatJSON({
        model,
        system: SYSTEM,
        maxTokens: 1400,
        messages: [{
          role: 'user',
          content: [
            // Stable prefix (candidate profile) cached; the JD varies per call.
            { type: 'text', text: `CANDIDATE\n${digest}\n\n---\n`, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: `\nJOB POSTING\n${jd}` },
          ],
        }],
      });
      // A firm minimum well past the candidate's ~1.5 years: penalise the score so it
      // sinks to the bottom, but keep it 'scored'. A 3-year ask is routinely won by a
      // strong 1.5-year candidate, and 'rejected' rows are hidden from the review queue
      // entirely - so rejecting here deleted the winnable market AND made it unauditable.
      const reqYears = Number(v.hard_experience_req);
      const tooSenior = Number.isFinite(reqYears) && reqYears > 4;
      await q(
        `UPDATE jobs SET score = $2, verdict = $3, stage = 'scored' WHERE id = $1`,
        [job.id, tooSenior ? Math.min(v.score ?? 0, 0.2) : (v.score ?? 0), JSON.stringify(v)]
      );
    } catch (err) {
      if (isFatal(err.message)) {
        fatal ??= err.message;
        return;   // no attempt burned - nothing about this job caused it
      }
      const attempts = (job.score_attempts ?? 0) + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await q(
        `UPDATE jobs SET score_attempts = $2, stage = $3 WHERE id = $1`,
        [job.id, attempts, giveUp ? 'rejected' : 'prefiltered']
      );
      console.warn(`  score failed for job ${job.id} (attempt ${attempts}${giveUp ? ', giving up' : ''}): ${err.message}`);
    }
  });

  if (fatal) {
    console.error(`
  !! scoring aborted - this is a configuration problem, not a job problem:
     ${fatal}
     Check ANTHROPIC_API_KEY in .env (or LLM_API_KEY if LLM_PROVIDER=openai).
     The queue is untouched; it will score normally once the key works.
`);
    return { scored: 0, above_threshold: 0, aborted: fatal };
  }

  const { rows: kept } = await q(`SELECT count(*) FROM jobs WHERE stage='scored' AND score >= $1`, [threshold]);
  return { scored: rows.length, above_threshold: Number(kept[0].count) };
}
