import { q } from '../db.js';
import { adapters } from '../adapters/index.js';
import { fingerprint, mapLimit } from '../util.js';
import { loadTargets } from '../config.js';

/** Upsert one normalized job. Returns 'new' | 'seen' | 'dup'. */
async function upsert(job) {
  if (!job?.title || !job?.url) return 'skip';
  const fp = fingerprint(job);

  // Same role reached us through two sources: keep the first, just touch it.
  const dup = await q(
    `SELECT id FROM jobs WHERE fingerprint = $1 AND NOT (source = $2 AND source_job_id = $3) LIMIT 1`,
    [fp, job.source, job.source_job_id]
  );
  if (dup.rowCount) {
    await q(`UPDATE jobs SET last_seen = now() WHERE id = $1`, [dup.rows[0].id]);
    return 'dup';
  }

  const res = await q(
    `INSERT INTO jobs (source, source_job_id, fingerprint, company, title, location,
                       remote, department, salary, url, description, posted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (source, source_job_id)
       DO UPDATE SET last_seen = now(), description = EXCLUDED.description, closed_at = NULL,
         -- JD changed since we last saw it: send it back through the pipeline.
         stage = CASE WHEN jobs.description IS DISTINCT FROM EXCLUDED.description
                      THEN 'new' ELSE jobs.stage END,
         score_attempts = CASE WHEN jobs.description IS DISTINCT FROM EXCLUDED.description
                               THEN 0 ELSE jobs.score_attempts END
     RETURNING (xmax = 0) AS inserted`,
    [job.source, job.source_job_id, fp, job.company, job.title, job.location, job.remote,
     job.department, job.salary, job.url, job.description, job.posted_at]
  );
  return res.rows[0].inserted ? 'new' : 'seen';
}

export async function ingest({ concurrency = 4 } = {}) {
  const targets = await loadTargets();
  // `empty` is the important one: a dead slug, a company that moved ATS, or a source
  // that started 500ing all return [] and log "-> 0", indistinguishable from "no
  // openings right now". Naming them every cycle is the only way you find out.
  const stats = { new: 0, seen: 0, dup: 0, skip: 0, errors: [], empty: [] };
  const reachedSources = new Set();

  await mapLimit(targets, concurrency, async (t) => {
    const adapter = adapters[t.ats];
    if (!adapter) return;
    try {
      const jobs = await adapter.fetchJobs(t);
      for (const job of jobs) {
        stats[await upsert(job)]++;
        if (job?.source) reachedSources.add(job.source);
      }
      if (t.id) await q(`UPDATE companies SET last_seen = now() WHERE id = $1`, [t.id]);
      if (!jobs.length) stats.empty.push(`${t.ats}/${t.slug ?? ''}`);
      console.log(`  ${t.ats}/${t.slug ?? ''} -> ${jobs.length}`);
    } catch (err) {
      stats.errors.push(`${t.ats}/${t.slug}: ${err.message}`);
    }
  });

  // Stale = not seen for 10 days on a source that DID return rows this pass. A source
  // that's down or returned nothing keeps its jobs open rather than mass-closing them.
  if (reachedSources.size) {
    await q(
      `UPDATE jobs SET closed_at = now()
       WHERE closed_at IS NULL AND last_seen < now() - interval '10 days'
         AND source = ANY($1)`,
      [[...reachedSources]]
    );
  }

  // Surface these explicitly - nested inside the returned object they get truncated
  // by console.log's depth limit exactly when there are enough of them to matter.
  for (const e of stats.errors) console.warn(`  ! source error: ${e}`);
  if (stats.empty.length) console.warn(`  ! ${stats.empty.length} source(s) returned 0 jobs: ${stats.empty.join(', ')}`);

  return stats;
}
