import express from 'express';
import cron from 'node-cron';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, pool, migrate } from '../src/db.js';
import { tailor } from '../src/resume/tailor.js';
import { render } from '../src/resume/render.js';
import { baselineSelection } from '../src/resume/baseline.js';
import { prepInterview } from '../src/interview/prep.js';
import { draftEmail } from '../src/outreach/email.js';
import { ingest } from '../src/pipeline/ingest.js';
import { prefilter } from '../src/pipeline/prefilter.js';
import { scoreAll } from '../src/pipeline/score.js';
import { notify, telegram } from '../src/pipeline/notify.js';
import { loadProfile, saveProfile, env, PIPELINE_STATUSES } from '../src/config.js';
import { chat, loadSettings, saveSettings } from '../src/llm.js';

const WEB_DIR = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

/**
 * Session-cookie login, gated on WEB_AUTH_EMAIL / WEB_AUTH_PASSWORD in .env.
 * This UI has your job pipeline, tailored resumes, AI provider keys and
 * resume content behind it - it should never sit open, even behind a tunnel.
 * If those two env vars aren't set, auth is skipped entirely (so a bare
 * `npm run web` on your own machine during dev still works with no login).
 *
 * The cookie is an HMAC-signed expiry timestamp, not a session store - one
 * user, one credential pair, no need for express-session. The signing secret
 * is generated fresh on boot, so restarting the server logs you out; fine
 * for a single-user local tool.
 */
function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function safeEqual(a, b) {
  const ha = sha256(a), hb = sha256(b);
  return crypto.timingSafeEqual(ha, hb);
}

const SESSION_COOKIE = 'job_agent_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_SECRET = crypto.randomBytes(32);

function signSession(exp) {
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(String(exp)).digest('base64url');
  return `${exp}.${mac}`;
}

function verifySession(cookieVal) {
  if (!cookieVal) return false;
  const [exp, mac] = cookieVal.split('.');
  if (!exp || !mac || Date.now() > Number(exp)) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(exp).digest('base64url');
  try {
    return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/api/login']);

function sessionAuth(req, res, next) {
  const wantUser = process.env.WEB_AUTH_EMAIL;
  const wantPass = process.env.WEB_AUTH_PASSWORD;
  if (!wantUser || !wantPass) return next(); // not configured - auth off
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (verifySession(req.cookies?.[SESSION_COOKIE])) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
  return res.redirect('/login.html');
}

// No cookie-parser dependency needed - we only ever read this one cookie.
app.use((req, _res, next) => {
  const header = req.headers.cookie || '';
  req.cookies = Object.fromEntries(
    header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))];
    })
  );
  next();
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const wantUser = process.env.WEB_AUTH_EMAIL;
  const wantPass = process.env.WEB_AUTH_PASSWORD;
  if (wantUser && wantPass && safeEqual(email || '', wantUser) && safeEqual(password || '', wantPass)) {
    const exp = Date.now() + SESSION_TTL_MS;
    // Not `secure` - the documented deploy path (DEPLOY.md) is an SSH tunnel to
    // plain http://localhost:3000, where a Secure cookie would never be sent.
    res.cookie(SESSION_COOKIE, signSession(exp), { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL_MS });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'invalid email or password' });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.use(sessionAuth);
app.use('/out', express.static(env.outDir));
app.use(express.static(path.join(WEB_DIR, 'public')));

app.get('/api/jobs', async (req, res) => {
  const min = Number(req.query.min ?? 0);
  const status = req.query.status || 'inbox';
  const maxAge = Number(req.query.age ?? env.maxAgeDays);
  const { rows } = await q(
    `SELECT j.id, j.score, j.keyword_score, j.stage, j.company, j.title, j.location, j.remote, j.salary, j.url,
            j.status, j.verdict, j.posted_at, j.source, j.viewed_at,
            (SELECT html_path FROM resumes r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS resume,
            (SELECT id FROM interview_preps p WHERE p.job_id = j.id ORDER BY p.id DESC LIMIT 1) AS prep_id
     FROM jobs j
     WHERE j.closed_at IS NULL AND j.stage <> 'rejected' AND ($2 = 'all' OR j.status = $2)
       AND ($1 <= 0 OR j.score >= $1)
       AND ($3 <= 0 OR COALESCE(j.posted_at, j.first_seen) >= now() - ($3 || ' days')::interval)
     ORDER BY round(COALESCE(j.score, j.keyword_score, 0)::numeric, 1) DESC,
              COALESCE(j.posted_at, j.first_seen) DESC NULLS LAST
     LIMIT 200`,
    [min, status, maxAge]
  );
  res.json(rows);
});

app.get('/api/jobs/:id/events', async (req, res) => {
  const { rows } = await q(
    `SELECT status, note, created_at FROM job_events WHERE job_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

app.post('/api/jobs/:id/status', async (req, res) => {
  const status = req.body.status;
  if (!PIPELINE_STATUSES.includes(status)) {
    return res.status(400).json({ error: `unknown status: ${status}` });
  }
  await q(`UPDATE jobs SET status = $2 WHERE id = $1`, [req.params.id, status]);
  await q(`INSERT INTO job_events (job_id, status, note) VALUES ($1, $2, $3)`,
    [req.params.id, status, req.body.note || null]);
  res.json({ ok: true });
});

// Fired via navigator.sendBeacon when "open posting" is clicked. COALESCE keeps
// the first-view timestamp on repeat clicks.
app.post('/api/jobs/:id/viewed', async (req, res) => {
  await q(`UPDATE jobs SET viewed_at = COALESCE(viewed_at, now()) WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/jobs/:id/prep', async (req, res) => {
  const { rows } = await q(
    `SELECT selection FROM interview_preps WHERE job_id = $1 ORDER BY id DESC LIMIT 1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'no prep yet for this job' });
  res.json({ ok: true, ...rows[0].selection });
});

app.post('/api/jobs/:id/prep', async (req, res) => {
  try {
    const { selection, dropped } = await prepInterview(Number(req.params.id));
    res.json({ ok: true, dropped, ...selection });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/:id/tailor', async (req, res) => {
  try {
    const profile = await loadProfile();
    const { job, selection, dropped } = await tailor(Number(req.params.id));
    const { rows } = await q(`SELECT id FROM resumes WHERE job_id=$1 ORDER BY id DESC LIMIT 1`, [job.id]);
    const out = await render({ job, selection, profile, resumeId: rows[0]?.id });
    res.json({
      ok: true, dropped,
      cover_note: selection.cover_note,
      html: out.html.replace(env.outDir, '/out'),
      pdf: out.pdf?.replace(env.outDir, '/out') || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Draft-only. Returns text for you to read, edit and send from your own mail
// client - the server has no mail transport and never sends anything.
app.post('/api/jobs/:id/email', async (req, res) => {
  try {
    const draft = await draftEmail(Number(req.params.id));
    res.json({ ok: true, to: draft.to_suggestion, subject: draft.subject, body: draft.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Profile (resume content) ---

app.get('/api/profile', async (_req, res) => {
  res.json(await loadProfile());
});

app.put('/api/profile', async (req, res) => {
  const body = req.body || {};
  for (const k of ['basics', 'skills', 'experience', 'projects', 'education', 'stories']) {
    if (!(k in body)) return res.status(400).json({ error: `missing ${k}` });
  }
  if (!['experience', 'projects', 'education', 'stories'].every((k) => Array.isArray(body[k]))) {
    return res.status(400).json({ error: 'experience/projects/education/stories must be arrays' });
  }
  const ids = [
    ...body.experience.flatMap((e) => (e.bullets || []).map((b) => b.id)),
    ...body.projects.map((p) => p.id),
  ];
  // Name the offender. A bare "duplicate id" was unfixable from the UI: the save
  // failed, the page kept the edits, and nothing said which of ~40 ids collided.
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return res.status(400).json({ error: `duplicate bullet/project id: ${dup}` });
  res.json({ ok: true, profile: await saveProfile(body) });
});

// General (non-job-tailored) baseline resume, straight from the full profile.
app.post('/api/profile/resume', async (_req, res) => {
  try {
    const profile = await loadProfile();
    const selection = baselineSelection(profile);
    const job = { id: 'baseline', company: profile.basics.name, title: 'resume', url: '' };
    const out = await render({ job, selection, profile });
    res.json({
      ok: true,
      html: out.html.replace(env.outDir, '/out'),
      pdf: out.pdf?.replace(env.outDir, '/out') || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Settings (AI provider config) ---
// Returns keys in plaintext to the (session-authenticated) browser - same
// trust level as .env already has today, not a new exposure for one user.

app.get('/api/settings', async (_req, res) => {
  res.json(await loadSettings());
});

app.put('/api/settings', async (req, res) => {
  const body = req.body || {};
  if (body.schedule_cron && !cron.validate(body.schedule_cron)) {
    return res.status(400).json({ error: `not a valid cron expression: ${body.schedule_cron}` });
  }
  const settings = await saveSettings(body);
  await reschedule();          // takes effect immediately - no restart
  res.json({ ok: true, settings, schedule: scheduled });
});

app.post('/api/settings/test', async (_req, res) => {
  try {
    const reply = await chat({
      system: 'Reply with the single word OK.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 10,
      temperature: 0,
    });
    res.json({ ok: true, reply: reply.trim().slice(0, 100) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/notify/test', async (_req, res) => {
  try {
    const sent = await telegram('<b>Ferry</b> is connected. This is a test notification.');
    res.json({ ok: true, sent, note: sent ? null : 'no telegram token/chat id set — printed to the server log instead' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- The pipeline: run it now, or on a schedule ---
// This process owns both. One `npm start` gives you the UI and the routine search;
// src/cli.js still runs any single stage by hand.

const STEPS = [
  ['ingest', () => ingest({ concurrency: env.concurrency })],
  ['prefilter', () => prefilter({ keep: env.keep, floor: env.prefilterFloor })],
  ['score', () => scoreAll({ concurrency: env.concurrency, threshold: env.scoreThreshold })],
  ['notify', () => notify({ threshold: env.notifyThreshold })],
];

// pg's AggregateError (every connection attempt failed) has an EMPTY .message, so
// a bare err.message renders as "search failed:" with nothing after it - the one
// failure you most need spelled out. Fall back to the stringified error.
const reason = (err) => err.message || String(err);

// Single-user app: one in-flight cycle, tracked in a plain object the dashboard polls.
const run = { running: false, step: null, startedAt: null, finishedAt: null, result: null, error: null };

async function cycle(trigger) {
  if (run.running) return false;
  Object.assign(run, { running: true, step: null, startedAt: Date.now(), finishedAt: null, result: null, error: null });
  console.log(`\n[${new Date().toISOString()}] cycle start (${trigger})`);
  const t0 = Date.now();
  const result = {};
  try {
    for (const [name, fn] of STEPS) {
      run.step = name;
      result[name] = await fn();
      console.log(`${name.padEnd(10)}`, result[name]);
    }
    run.result = result;
  } catch (err) {
    console.error('cycle failed:', err);
    run.error = reason(err);
    run.result = result;                       // whatever finished before the failure
  }
  Object.assign(run, { running: false, step: null, finishedAt: Date.now() });
  console.log(`cycle done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return true;
}

app.post('/api/run', async (_req, res) => {
  if (run.running) return res.status(409).json({ error: `already running (${run.step})`, ...run });
  cycle('manual');                              // fire and forget; poll /api/run/status
  res.json({ ok: true, started: true });
});

app.get('/api/run/status', (_req, res) => res.json(run));

let task = null;
let scheduled = null;

/** (Re)arm the routine search from settings.json, falling back to INGEST_CRON. */
async function reschedule() {
  const settings = await loadSettings();
  task?.stop();
  task = null;
  const expr = settings.schedule_cron || env.cron;
  const off = settings.schedule_enabled === 'false' || settings.schedule_enabled === false;
  scheduled = off || !cron.validate(expr) ? null : expr;
  if (scheduled) task = cron.schedule(scheduled, () => cycle('schedule'));
  console.log(scheduled ? `routine search: ${scheduled}` : 'routine search: off');
  return scheduled;
}

// Don't die at boot if Postgres isn't up yet - serve the UI and let the routes
// report the failure. A dead DB is usually transient (a container still
// starting); an exited web server needs a human.
await migrate().catch((err) => console.error(`migrate failed, continuing: ${reason(err)}`));
await reschedule();

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`review queue on http://localhost:${port}`));
process.on('SIGTERM', () => { task?.stop(); pool.end(); });
