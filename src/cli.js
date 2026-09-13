#!/usr/bin/env node
import fs from 'node:fs/promises';
import { pool, q, migrate } from './db.js';
import { ingest } from './pipeline/ingest.js';
import { prefilter } from './pipeline/prefilter.js';
import { scoreAll } from './pipeline/score.js';
import { notify } from './pipeline/notify.js';
import { discoverAndSave } from './discovery/detect.js';
import { tailor as tailorResume } from './resume/tailor.js';
import { render } from './resume/render.js';
import { prepInterview } from './interview/prep.js';
import { loadProfile, env, PIPELINE_STATUSES } from './config.js';
import { mapLimit } from './util.js';

const [cmd, ...args] = process.argv.slice(2);

const commands = {
  async migrate() { await migrate(); },

  async ingest() { console.log(await ingest({ concurrency: env.concurrency })); },

  async prefilter() { console.log(await prefilter({ keep: env.keep, floor: env.prefilterFloor })); },

  async score() { console.log(await scoreAll({ concurrency: env.concurrency, threshold: env.scoreThreshold })); },

  async notify() { console.log(await notify({ threshold: env.notifyThreshold })); },

  async run() {
    console.log('ingest:', await ingest({ concurrency: env.concurrency }));
    console.log('prefilter:', await prefilter({ keep: env.keep, floor: env.prefilterFloor }));
    console.log('score:', await scoreAll({ concurrency: env.concurrency, threshold: env.scoreThreshold }));
    console.log('notify:', await notify({ threshold: env.notifyThreshold }));
  },

  /** discover <domain> — resolve one company's ATS and add it to the crawl list. */
  async discover() {
    const found = await discoverAndSave(args[0]);
    console.log(found ? `${args[0]} -> ${found.ats}/${found.slug}` : `${args[0]}: no known ATS found`);
  },

  /** discover:bulk <file> — one domain per line. */
  async 'discover:bulk'() {
    const lines = (await fs.readFile(args[0], 'utf8'))
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    let hits = 0;
    await mapLimit(lines, 5, async (d) => {
      const found = await discoverAndSave(d).catch(() => null);
      if (found) { hits++; console.log(`  ${d} -> ${found.ats}/${found.slug}`); }
      else console.log(`  ${d} -> none`);
    });
    console.log(`${hits}/${lines.length} resolved`);
  },

  /** list [minScore] */
  async list() {
    const min = Number(args[0] ?? env.scoreThreshold);
    const { rows } = await q(
      `SELECT id, score, company, title, location, status, url FROM jobs
       WHERE score >= $1 AND closed_at IS NULL AND status <> 'skipped'
       ORDER BY score DESC LIMIT 40`, [min]);
    for (const r of rows) {
      console.log(`[${r.id}] ${(r.score * 100).toFixed(0)}%  ${r.title} — ${r.company} (${r.location || 'n/a'}) [${r.status}]`);
      console.log(`      ${r.url}`);
    }
  },

  /** tailor <jobId> — generate a job-specific resume + cover note. */
  async tailor() {
    const jobId = Number(args[0]);
    const profile = await loadProfile();
    const { job, selection, dropped } = await tailorResume(jobId);
    const { rows } = await q(`SELECT id FROM resumes WHERE job_id=$1 ORDER BY id DESC LIMIT 1`, [jobId]);
    const out = await render({ job, selection, profile, resumeId: rows[0]?.id });
    console.log(`\n${job.title} — ${job.company}\n${job.url}\n`);
    console.log(selection.cover_note || '');
    if (dropped.length) console.log(`\n(dropped ${dropped.length} unsourced bullets)`);
    console.log(`\nwrote ${out.pdf || out.html}`);
    console.log('Review it, then apply yourself on the posting page.');
  },

  /** mark <jobId> <status> */
  async mark() {
    const [id, status] = args;
    if (!PIPELINE_STATUSES.includes(status)) {
      console.error(`unknown status: ${status}
use one of: ${PIPELINE_STATUSES.join(' | ')}`);
      process.exitCode = 1;
      return;
    }
    await q(`UPDATE jobs SET status = $2 WHERE id = $1`, [Number(id), status]);
    await q(`INSERT INTO job_events (job_id, status) VALUES ($1, $2)`, [Number(id), status]);
    console.log('ok');
  },

  /** prep <jobId> — interview prep notes, grounded only in profile.json's stories[]. */
  async prep() {
    const jobId = Number(args[0]);
    const { job, selection, dropped } = await prepInterview(jobId);
    console.log(`\n${job.title} — ${job.company}\n`);
    console.log('likely questions:');
    for (const question of selection.likely_questions || []) console.log(`  - ${question}`);
    console.log('\nstory matches:');
    for (const m of selection.story_matches || []) console.log(`  [${m.id}] ${m.question}\n      ${m.angle}`);
    if (selection.gaps?.length) {
      console.log('\ngaps (no story for these):');
      for (const g of selection.gaps) console.log(`  - ${g}`);
    }
    if (selection.questions_to_ask?.length) {
      console.log('\nask them:');
      for (const a of selection.questions_to_ask) console.log(`  - ${a}`);
    }
    if (dropped.length) console.log(`\n(dropped ${dropped.length} unsourced story ref(s))`);
  },

  async help() {
    console.log(`job-agent
  migrate                 create the schema
  discover <domain>       resolve a company's ATS + slug
  discover:bulk <file>    same, for a file of domains
  ingest                  pull all sources
  prefilter               cheap keyword pass
  score                   LLM relevance pass on survivors (score + per-dimension fit)
  notify                  push new high scorers to Telegram
  run                     ingest -> prefilter -> score -> notify
  list [minScore]         show current matches
  tailor <jobId>          write a tailored resume + cover note to out/
  prep <jobId>            interview prep notes, grounded only in profile.json's stories[]
  mark <jobId> <status>   inbox | shortlist | applied | phone_screen | interview |
                          offer | rejected | withdrawn | skipped`);
  },
};

await (commands[cmd] || commands.help)();
await pool.end();
