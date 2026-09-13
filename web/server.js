import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q, pool } from '../src/db.js';
import { tailor } from '../src/resume/tailor.js';
import { render } from '../src/resume/render.js';
import { baselineSelection } from '../src/resume/baseline.js';
import { prepInterview } from '../src/interview/prep.js';
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
  if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'duplicate bullet/project id' });
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
  res.json({ ok: true, settings: await saveSettings(req.body || {}) });
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`review queue on http://localhost:${port}`));
process.on('SIGTERM', () => pool.end());
