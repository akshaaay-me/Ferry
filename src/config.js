import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import 'dotenv/config';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = async (p) => JSON.parse(await fs.readFile(path.join(root, p), 'utf8'));

export const loadProfile = () => readJSON('config/profile.json');

/**
 * Writes only the resume-content sections of profile.json. Spreads the
 * current file first so `match` (job-scoring config) and any `_comment`
 * keys survive untouched even if the caller's `next` includes them.
 */
export async function saveProfile(next) {
  const current = await loadProfile();
  const merged = {
    ...current,
    basics: next.basics,
    skills: next.skills,
    experience: next.experience,
    projects: next.projects,
    education: next.education,
    stories: next.stories,
  };
  await fs.writeFile(path.join(root, 'config/profile.json'), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

/** Targets = the companies table (grown by discovery) plus the static feeds. */
export async function loadTargets() {
  const cfg = await readJSON('config/targets.json');
  const targets = [];

  const { rows } = await q(`SELECT id, name, ats, slug FROM companies WHERE active`);
  targets.push(...rows);

  for (const c of cfg.companies || []) {
    if (c.slug && c.slug !== 'REPLACE_ME') targets.push(c);
  }
  for (const f of cfg.feeds || []) targets.push({ ats: 'feeds', slug: f, name: f });
  if (cfg.hn) targets.push({ ats: 'hn', slug: 'whoishiring', name: 'Hacker News' });
  if (cfg.embeddedjobs) targets.push({ ats: 'embeddedjobs', slug: 'listing', name: 'embedded.jobs' });

  // De-duplicate by ats+slug.
  const seen = new Set();
  return targets.filter((t) => {
    const k = `${t.ats}:${t.slug}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The full pipeline, in order. 'inbox' is the implicit start (the jobs table default);
 * 'skipped' is reachable from anywhere. Exported here so the CLI and the web UI validate
 * against the same list - `cli mark` used to write any string straight into jobs.status.
 */
export const PIPELINE_STATUSES = [
  'inbox', 'shortlist', 'applied', 'phone_screen', 'interview',
  'offer', 'rejected', 'withdrawn', 'skipped',
];

export const env = {
  keep: Number(process.env.PREFILTER_KEEP || 40),
  prefilterFloor: Number(process.env.PREFILTER_FLOOR || 0.35),
  scoreThreshold: Number(process.env.SCORE_THRESHOLD || 0.65),
  notifyThreshold: Number(process.env.NOTIFY_THRESHOLD || 0.75),
  concurrency: Number(process.env.CONCURRENCY || 4),
  maxAgeDays: Number(process.env.MAX_AGE_DAYS || 1),
  cron: process.env.INGEST_CRON || '0 */3 * * *',
  outDir: path.join(root, 'out'),
};
