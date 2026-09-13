# Ferry

Finds jobs, scores them against your actual experience, and writes a tailored resume per posting.
**It does not apply for you.** Applying stays manual, on purpose.

## Why it finds jobs the boards miss

It doesn't scrape job boards. It reads the public ATS endpoints that companies
publish so their own careers page can render — Greenhouse, Lever, Ashby, Workable,
Recruitee, SmartRecruiters, **Workday**. No keys, no browser, no anti-bot fight, and
the data is first-party and fresh. The discovery crawler grows that list for you.

**Workday is the one that matters for embedded.** NXP, Analog Devices, Micron,
Cadence, Applied Materials, TI, Bosch, Continental, Qualcomm, Honeywell, Siemens and
Garmin all run it, all staff large Bengaluru / Hyderabad / Noida / Pune engineering
sites, and none of them are visible to any remote-job aggregator. It is also the only
adapter whose `searchText` filters *server-side*, so it pulls ~40 embedded roles per
tenant instead of 2000 of everything.

On top of that: Hacker News "Who is Hiring" (parsed from the Algolia API), and Adzuna
for Indian-market (Naukri/Indeed-tier) coverage — free key, and the only source here
that sees that market at all.

**Deliberately off** (see `config/targets.json`, which records why): the six remote
aggregators — remotive, arbeitnow, himalayas, remoteok, weworkremotely, themuse. Measured
together on one pass they returned 477 rows and **zero** embedded-titled roles. Their
adapters are still in `src/adapters/feeds.js`; re-add a name to `feeds[]` to revive one.
`embedded.jobs` is off too — the site itself returns HTTP 500 on every path.

## Pipeline

```
cron ──▶ ingest ──▶ prefilter ──▶ score ──▶ notify ──▶ review queue ──▶ tailor ──▶ you apply
         adapters   keywords,     Claude    Telegram    web UI          Claude
                    free,         reads                                 + Typst
                    ~5000 rows    top 40
```

The two-stage filter is the whole cost story. Keyword scoring is free and cuts
thousands of postings to forty; only then does an LLM read a full JD. Running Claude
over every posting would cost real money for no extra signal.

**`include_titles` beats the exclude lists.** The exclude lists are raw substrings, so
`"ml engineer"` used to hard-zero *Embedded ML Engineer* and `"solutions architect"`
killed *IoT Solutions Architect* — the exact roles this search exists to find, deleted
before any LLM saw them and hidden from the review queue. A title matching
`include_titles` is in-domain by definition and now short-circuits both exclude lists;
`exclude_companies` stays unconditional. Seniority is graded by the LLM, not used as a
kill — the two stages used to contradict each other on this.

The `score` stage returns one holistic 0-1 number (what everything else - thresholds,
sorting, notifications - keys off) plus a `dimensions` breakdown (skill / seniority /
location / growth fit, each 1-5) purely so the review queue can show *why* a score
landed where it did at a glance, not just the number.

## Deploy

Want this running continuously on its own VM instead of your laptop? See
[`DEPLOY.md`](./DEPLOY.md).

## Setup

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY, optionally Telegram, optionally WEB_AUTH_*
docker compose up -d db
npm install
npm run migrate
```

Then fill in `config/profile.json` — this is the important file. It is your resume as a
**tagged bullet inventory**, not a document. Fill in the placeholders (`REPLACE_ME`,
contact details, dates) and add bullets for anything missing. Edit the JSON directly, or
use the Profile page (`/profile.html`) once `npm run web` is up — same file either way.

## Build your target list

```bash
npm run cli discover ather.com                    # one company
npm run cli discover:bulk config/seed-domains.txt # a whole list
```

The crawler fetches `/careers`, `/jobs` etc., looks for an ATS fingerprint in the
HTML, and stores `(company, ats, slug)`. Seed `seed-domains.txt` from the YC
directory, a Tracxn/Crunchbase export of Indian hardware and IoT startups, the
customer logos of tools you already use, and your LinkedIn follows. Getting this
list to a few hundred companies is where the value is.

## Run it

```bash
npm run cli run     # ingest -> prefilter -> score -> notify, once
npm start           # same, on a cron (INGEST_CRON, default every 3h)
npm run web         # review queue at localhost:3000
```

```bash
npm run cli list 0.75          # current matches
npm run cli tailor 412         # resume + cover note for job 412 -> out/
npm run cli prep 412           # interview prep notes for job 412, grounded in profile.json's stories[]
npm run cli mark 412 applied   # advance it through the pipeline - logs a job_events row too
```

## Review queue

`npm run web` (or the `web` service under Docker) serves a small multi-page UI at
`localhost:3000` (`web/public/*.html`, no build step). It's not a dashboard you glance
at; every action on it writes back to the database:

- **review queue** (`/`) - filter by pipeline stage (inbox/shortlist/applied/.../skipped)
  and minimum score; each card shows the score, per-dimension breakdown, the verdict, and
  any gaps the scoring pass flagged
  - **open posting** - the original listing, new tab; also stamps the job `viewed_at`
    (dims the card and adds a "seen" tag next time you load the queue)
  - a stage dropdown to move the job through the pipeline (see "Pipeline tracker" below)
  - **tailor resume** / **prep interview** - run those steps live and show the result inline
  - **last resume** / **last prep** - once generated, re-open without regenerating
  - **timeline** - the `job_events` history for that job
- **profile** (`/profile.html`) - edit `config/profile.json` (basics, skills, experience
  bullets, projects, education, interview stories) from a form instead of hand-editing
  JSON, plus a **generate resume** button for a baseline (non-job-tailored) resume
- **settings** (`/settings.html`) - configure the AI provider (Anthropic, OpenRouter, Groq,
  Ollama, ...) and per-stage model overrides from the UI instead of `.env` - saved to
  `config/settings.json` (gitignored) and picked up on the next LLM call, no restart

If `WEB_AUTH_EMAIL` / `WEB_AUTH_PASSWORD` are set in `.env`, all of this sits behind a
login page (`/login.html`, session cookie - see `web/server.js`) - leave them blank for
local dev, set them before this is reachable from anywhere but your own machine. Either
way, treat the port itself as private: see `DEPLOY.md` for reaching it over an SSH tunnel
or a Cloudflare Tunnel instead of exposing it directly.

## Resume tailoring, and the guardrail

The model never sees a resume document. It sees the bullet inventory from
`profile.json` and the job description, and must return **the id of every bullet it
uses**. `validate()` in `src/resume/tailor.js` drops anything whose id isn't in the
inventory before rendering. It can reorder, compress, and rephrase to match the
posting's vocabulary; it cannot invent an employer, a technology, or a metric.

That check is not decoration. A hallucinated line on a resume is something you get
caught on in an interview, months later.

Output lands in `out/<jobid>-<company>-<title>/`: a `.pdf` (via Typst), a `.html`
fallback, `cover-note.txt`, and `selection.json` showing exactly what was chosen and
what was left out.

## Pipeline tracker

`status` is more than inbox/shortlist/applied/skipped now - it's a real pipeline:
`inbox → shortlist → applied → phone_screen → interview → offer / rejected / withdrawn`,
with `skipped` reachable from anywhere. Every change is also logged to `job_events`
(status + timestamp, optional note), so the review queue's "timeline" button on each
card shows the actual history, not just the current state.

## Interview prep

Same guardrail idea as resume tailoring, applied to interview prep instead. Add
STAR-format stories to `stories[]` in `config/profile.json` (situation/task/action/result,
tagged like the resume bullets). `npm run cli prep <jobId>` (or the "prep interview"
button in the review queue) asks Claude which likely questions this posting will raise
and which of your stories answers each one - `validate()` in `src/interview/prep.js`
drops any story id it didn't actually pull from your inventory, so it can't hand you a
talking point citing a metric or outcome you never wrote down. It also flags question
types you have no story for yet, so you know what to prep before the call, not during it.

## Why applying is manual

Auto-submit at volume gets you pattern-flagged by ATS dedup, breaks on custom
screening questions, trips honeypot fields, and converts worse than a smaller number
of considered applications. The leverage is in *finding* the right twenty roles and
*tailoring* for them. Clicking submit takes ten seconds and is the one step where
your judgment is actually worth something.

## Adding a source

One file in `src/adapters/`, exporting `name`, `fetchJobs({slug, name})` returning
normalized jobs, and optionally `detect(html)` for the discovery crawler. Register it
in `src/adapters/index.js`. Nothing downstream changes.

## Notes

- Verify ATS endpoint shapes before you trust a source at scale; they drift. `ingest`
  now prints every source that returned **0 jobs** at the end of each cycle — a dead
  slug, a company that changed ATS, and "no openings right now" are otherwise identical
  from the outside, and that is this system's most dangerous failure mode. Check that line.
- Workday slugs are `tenant:host:site` (e.g. `nxp:wd3:careers`). All three parts are
  per-customer and none is derivable from the others, so `workday.js:detect()` reads
  them off a careers page for `discover:bulk`.
- `src/util.js` sets a descriptive User-Agent. Keep it honest and keep concurrency low.
- The embedding prefilter (Voyage) is optional and off by default; the keyword pass
  is good enough until your target list gets large.
- `src/llm.js` isn't locked to Claude: set `LLM_PROVIDER=openai` in `.env` (or
  from the Settings page - see "Review queue" above) and it speaks the
  OpenAI-compatible chat/completions shape instead - that covers OpenRouter,
  Groq, Together, or a self-hosted Ollama/vLLM/llama.cpp server, so any
  open-weight model (Llama, DeepSeek, Qwen, Mistral, ...) works too. See
  `.env.example` for ready-to-uncomment configs. `score.js` and `tailor.js`
  don't change either way - they just call `chatJSON()`.
- Indian embedded startups mostly sit on Keka, Darwinbox and Zoho Recruit, which have no
  adapter here yet — a careers-page fingerprint scan over `config/seed-domains.txt` found
  Zoho Recruit (Ultrahuman), Darwinbox (Pixxel), Jobvite (SiMa.ai), Teamtailor (Memfault)
  and Rippling (Formant). All are JS-rendered and each needs its own reverse-engineering.
  Until then HN and Adzuna carry that niche.
- Wellfound, Otta (now folded into Welcome to the Jungle), and Hirist.tech were checked
  and deliberately left out: none expose a public API, and every existing integration
  for them is a paid scraper fighting their bot protection or a login wall - exactly the
  fight this project is built to avoid. `embeddedjobs.js` is the one exception to "API
  only": its listing page has no auth or bot wall, so it's scraped lightly (one listing
  page, no per-job detail fetch), which means its `description` is a short synthesized
  summary rather than a full JD - weaker prefilter signal than the ATS sources. If it
  stops returning jobs, the page markup likely changed; the heuristics live in
  `src/adapters/embeddedjobs.js`.
# Ferry
Automates the job hunt: finds postings, filters the noise, preps your resume and interview material per role.
