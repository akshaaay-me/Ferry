// Runnable check: `node src/pipeline/prefilter.test.mjs`. No framework.
import assert from 'node:assert/strict';
import { scoreJob, promote } from './prefilter.js';

const match = {
  include_titles: ['embedded', 'firmware'],
  exclude_titles: ['sales', 'recruiter'],
  exclude_seniority: ['staff', 'principal'],
  exclude_companies: ['acme'],
  locations: ['bengaluru', 'remote'],
  remote_ok: true,
  keywords: { stm32: 4, firmware: 4, rtos: 3, 'edge ai': 5, python: 1 },
};

// scoreJob --------------------------------------------------------------
assert.equal(scoreJob({ title: 'Sales Engineer' }, match).score, 0, 'excluded title -> 0');
assert.equal(scoreJob({ title: 'Staff Recruiter' }, match).score, 0, 'excluded seniority -> 0');
// "Staff Firmware Engineer" is in-domain (include_titles hit), so seniority no longer
// kills it - score.js grades the stretch instead. See the regression block below.
assert.ok(scoreJob({ title: 'Staff Firmware Engineer' }, match).score > 0, 'in-domain title outranks exclude_seniority');
assert.equal(scoreJob({ title: 'Firmware Engineer', company: 'Acme Corp' }, match).score, 0, 'excluded company -> 0');

const strong = scoreJob(
  { title: 'Embedded Firmware Engineer', location: 'Bengaluru',
    description: 'STM32, FreeRTOS, edge AI, firmware in embedded C' },
  match,
);
assert.ok(strong.score > 0.8, `strong match should score high, got ${strong.score}`);

const offLoc = scoreJob(
  { title: 'Embedded Firmware Engineer', location: 'Berlin, Germany',
    description: 'STM32, firmware, edge AI, RTOS' },
  match,
);
assert.ok(offLoc.score < strong.score, 'off-location is penalised vs same JD in-location');
assert.ok(offLoc.score > 0, 'off-location still reaches the LLM (not killed)');

// promote -------------------------------------------------------------------
const scored = [
  { id: 1, score: 0.9 },
  { id: 2, score: 0.5 },
  { id: 3, score: 0.36 },
  { id: 4, score: 0.2 },   // above 0 but below floor -> stays 'new'
  { id: 5, score: 0 },     // hard exclude -> 'rejected'
];
const next = promote(scored, { keep: 2, floor: 0.35 });
const stage = Object.fromEntries(next.map((n) => [n.id, n.stage]));
assert.deepEqual(stage, { 1: 'prefiltered', 2: 'prefiltered', 3: 'new', 4: 'new', 5: 'rejected' },
  `keep=2 promotes top 2 above floor; sub-floor stays new; only 0 rejected. got ${JSON.stringify(stage)}`);

console.log('ok - prefilter');

// Regression: include_titles must beat the exclude lists -------------------------
// These four all scored 0 (permanently 'rejected', hidden from the review queue)
// because "ml engineer" / "solutions architect" / "support engineer" / "staff" are
// raw substrings in the exclude lists. They are exactly the target roles.
const embMatch = {
  ...match,
  include_titles: ['embedded', 'firmware', 'iot', 'edge ai', 'hardware'],
  exclude_titles: ['sales', 'ml engineer', 'solutions architect', 'support engineer', 'full stack'],
};
const jd = 'STM32, FreeRTOS, edge AI, firmware in embedded C, TFLite';

for (const title of ['Embedded ML Engineer', 'IoT Solutions Architect',
                     'Hardware Support Engineer', 'Staff Embedded Engineer']) {
  const r = scoreJob({ title, location: 'Bengaluru', description: jd }, embMatch);
  assert.ok(r.score > 0, `in-domain title must survive the exclude lists: "${title}" got ${r.score} (${r.reason})`);
}

// ...but a genuinely out-of-domain title is still killed.
assert.equal(
  scoreJob({ title: 'Full Stack Developer', location: 'Bengaluru', description: jd }, embMatch).score,
  0, 'no include_titles hit -> exclude list still applies');
assert.equal(
  scoreJob({ title: 'Embedded Engineer', company: 'Acme Corp', description: jd }, embMatch).score,
  0, 'excluded company is unconditional, even for an in-domain title');

// Greenhouse detect: the /js embed form used to capture "embed" as the slug ---------
const { detect: ghDetect } = await import('../adapters/greenhouse.js');
for (const url of [
  'https://boards.greenhouse.io/embed/job_board/js?for=netradyne',
  'https://boards.greenhouse.io/embed/job_board?for=netradyne',
  'https://boards.greenhouse.io/netradyne',
  'https://job-boards.greenhouse.io/netradyne',
]) assert.equal(ghDetect(url), 'netradyne', `greenhouse slug from ${url}`);

console.log('ok - regressions');
