# Deploying job-agent to a VM

Goal: `web` - the review queue *and* the routine search (ingest → prefilter →
score → notify) in one process - runs continuously on a small VM, survives reboots
and crashes, and the review UI is reachable by you only. It does have its own
login now (§6), but that's a single email/password pair, not a real access
layer - the port itself must still never sit on the open internet.

Two services, that's all: `db` (Postgres + pgvector) and `web` (everything else).

- **First time?** §0 → §7, in order. Budget half an hour, most of it waiting on
  the image build.
- **Already deployed and you just changed some code?** Jump to
  [§8 Updating after a code change](#8-updating-after-a-code-change). The short
  version is `git pull && docker compose up -d --build --remove-orphans`, and §8
  explains why each of those flags is there.

## First-time checklist

Tick these off in order; each section below is the detail for one line.

- [ ] §0 — repo is **private** (`config/profile.json` has your phone number in it)
- [ ] §1 — VM up, firewall open on **port 22 only**
- [ ] §2 — Docker installed, `docker compose version` works
- [ ] §3 — code on the VM (git clone, or scp)
- [ ] §4 — `.env` created from `.env.example`, `WEB_AUTH_*` set to a long password
- [ ] §5 — `docker compose up -d --build`, first cycle looks sane in the logs
- [ ] §5 — `sudo systemctl enable docker` so it all comes back after a reboot
- [ ] §6 — tunnel chosen and running as a service; UI loads from your laptop
- [ ] Settings page — AI provider + Telegram + routine search schedule
- [ ] Profile page — job preferences (target roles, locations) match what you want
- [ ] §7 — a backup cron exists and you've tested the restore once

## 0. Before you provision anything

`config/profile.json` has your real email and phone in it, and it is **not**
git-ignored (only `.env`, `config/settings.json`, `node_modules/`, `out/`, and
`*.pdf` are, per `.gitignore`). If you put this repo on GitHub, make the repo
**private** - don't rely on remembering to scrub it later.

`config/settings.json` (written by the web UI's Settings page - see README)
holds AI provider keys, same as `.env` - it just isn't tracked by git at all,
so there's nothing to scrub there, but back it up like you would `.env` (§7).

## 1. Pick a VM

Anything with 1-2 vCPU / 2GB RAM is plenty (Postgres + a couple of small
Node processes). An EC2 `t3.small`, a Hetzner CX22, or a DigitalOcean
Basic droplet all work. Ubuntu 22.04/24.04 LTS. In the security group /
firewall, open **only port 22** (SSH) to the internet - nothing else needs
to be public; §6 covers how you'll still reach the review UI.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker          # or log out/in so the group membership takes effect
docker compose version # confirm the plugin is present (bundled with modern Docker)
```

## 3. Get the code onto the VM

Two options - either is fine, git makes future updates a one-liner:

```bash
# Option A: push this repo to a *private* GitHub repo first, then on the VM:
git clone git@github.com:<you>/job-agent.git && cd job-agent

# Option B: copy the folder up directly from your machine
scp -r ./job-agent user@<vm-ip>:~/job-agent
```

## 4. Configure secrets

```bash
cd job-agent
cp .env.example .env
nano .env
```

On a VM, exactly two things in `.env` genuinely have to be right before you start:

```ini
WEB_AUTH_EMAIL=you@example.com
WEB_AUTH_PASSWORD=<long random string>
```

Everything else can wait. Leave them blank and the UI has **no login at all** - fine
on your laptop, not on a machine with a public IP. The AI provider, Telegram and the
search schedule are all better set afterwards from the Settings page anyway (see
below), so `.env` on the VM can stay nearly empty.

`docker-compose.yml` already points `DATABASE_URL` at the `db` container for
you inside Docker - the `DATABASE_URL` line in `.env` only matters if you
ever run the pipeline outside Docker.

The AI provider block (`ANTHROPIC_API_KEY` / `LLM_PROVIDER` / `LLM_*`), the
`TELEGRAM_*` pair and `INGEST_CRON` can all be left blank here and set later from
the Settings page (`/settings.html`) once `web` is up. That page writes
`config/settings.json`, which `docker-compose.yml` already bind-mounts
(`./config:/app/config`, same as `profile.json`), and those values take precedence
over the matching `.env` vars - so no redeploy, and no editing files over SSH, for
any of it. `.env` stays the fallback for anything you leave unset there.

## 5. Start it

```bash
docker compose up -d --build
docker compose logs -f web   # watch the first cycle: ingest, prefilter, score, notify
```

The first build takes a few minutes (it downloads Typst for PDF rendering); later
ones are cached and quick.

`web` (`web/server.js`) runs the DB migration itself on boot, so there's no
separate migrate step to remember under Compose. It also owns the schedule: the
cron comes from `config/settings.json` (Settings → routine search, bind-mounted
so it survives a redeploy), falling back to `INGEST_CRON` in `.env`. There is no
longer a separate `agent` service - it ran `src/index.js`, which is gone.

A healthy first boot logs, in this order:

```
schema ready
routine search: 0 */3 * * *
review queue on http://localhost:3000
[<timestamp>] cycle start (schedule)
  greenhouse/netradyne -> 14
  workday/nxp:wd3:careers -> 38
  ...
ingest     { new: 212, seen: 0, dup: 4, skip: 0, errors: [], empty: [] }
```

Read the `empty:` list and the `! source error:` lines - a dead slug and "no
openings right now" both look like `-> 0`, and that is this system's quietest
failure mode. If `ingest` reports zero everywhere, the container has no network or
every slug is stale; if `score` errors, your AI provider key is wrong (fix it on the
Settings page, no redeploy needed).

Both `db` and `web`'s ports are bound to `127.0.0.1` in `docker-compose.yml`
(already set up this way) - reachable from the VM itself, not from the
internet. Both services also carry `restart: unless-stopped`, so Docker
brings them back after a crash or a VM reboot, as long as the Docker daemon
itself starts on boot:

```bash
sudo systemctl enable docker
```

## 6. Reach the review UI privately

The UI now has a login of its own - a session-cookie login page
(`/login.html`), gated on `WEB_AUTH_EMAIL` / `WEB_AUTH_PASSWORD` in `.env`
(blank = no login prompt, which is fine for local dev but not once this is
reachable from anywhere else). That's a baseline, not a replacement for
keeping the port off the public internet - still pick one of the two below.

Pick one:

**SSH tunnel** (zero extra setup, good for occasional checks):
```bash
ssh -L 3000:localhost:3000 user@<vm-ip>
# then open http://localhost:3000 in your own browser
```

**Cloudflare Tunnel** (since you're already on Cloudflare - gives you a
stable HTTPS URL you can also open from your phone):
```bash
# on the VM
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared
cloudflared tunnel login
cloudflared tunnel create job-agent
cloudflared tunnel route dns job-agent jobs.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 job-agent
```
Then put that hostname behind **Cloudflare Access** (Zero Trust dashboard -
free for a handful of users) so it asks for your own login before it'll load
- the app's own login above is one shared credential pair, not real access
control, so Access is what actually locks the door here.
Run `cloudflared` as a systemd service (`cloudflared service install`) so it
survives reboots the same way the containers do.

## 7. Backups

- Postgres data lives in the `pgdata` named volume - survives container
  restarts and rebuilds, not a VM loss. Back it up:
  ```bash
  docker compose exec db pg_dump -U jobagent jobagent | gzip > "backup-$(date +%F).sql.gz"
  ```
  Put that in a daily cron job and ship the file off-box (S3, Cloudflare R2,
  even just `scp` back to your laptop).
- `out/` (tailored resumes, cover notes, `selection.json`) is bind-mounted to
  the VM's own disk already (`./out:/app/out`), so it's already outside the
  container - sync or download it periodically the same way.
- `config/settings.json` (if you've set AI provider keys from the Settings
  page instead of `.env`) is git-ignored, so a fresh `git clone` won't bring
  it back - it's bind-mounted (`./config:/app/config`) same as `profile.json`,
  so back it up the same way you'd back up `.env`.

## 8. Updating after a code change

The normal update, once the VM is already running:

```bash
cd ~/job-agent
git pull
docker compose up -d --build --remove-orphans
docker compose logs -f web     # confirm it came back up
```

Both flags on that third line earn their place, and the `--remove-orphans` one will
bite you exactly once if you leave it off. The rest of this section is what to do when
that command isn't enough.

### `--remove-orphans` is required for this update

There used to be a second service, `agent`, running `src/index.js` on its own cron.
It is gone - `web` now owns both the UI and the schedule. But Compose does **not**
stop a container whose service you deleted from the file; it warns about an "orphan"
and leaves it running on its old image. That old image still has the old code inside
it, so it keeps working - and you end up with **two schedulers ingesting and
notifying in parallel**, which looks like duplicate Telegram messages and doubled
API spend, not like a crash. `--remove-orphans` is what actually stops it.

Check for yourself after the first update - the only thing that should be listed
besides `db` is `web`:

```bash
docker compose ps
```

### `git pull` will fight you over `config/profile.json`

`config/profile.json` is **tracked by git** and is also the file the Profile page
writes to. So the moment you edit your profile or your job preferences through the UI
on the VM, that VM has local changes to a tracked file, and `git pull` refuses:

(`config/targets.json` is tracked too and hits the same wall if you've hand-edited it
on the VM. Your discovered companies are safe either way - those live in the database,
not in that file.)

> error: Your local changes to the following files would be overwritten by merge

The VM's copy is the one with your real edits in it. Keep it:

```bash
cp config/profile.json ~/profile.vm.json    # save what the UI wrote, outside the repo
git stash                                    # park the local edits
git pull                                     # now succeeds
git stash pop                                # replay them
```

If both sides changed the file, `stash pop` does **not** merge JSON sensibly - it
leaves conflict markers in it:

```
<<<<<<< Updated upstream
{"basics": {"name": "..."}}
=======
{"basics": {"name": "..."}}
>>>>>>> Stashed changes
```

That file is parsed by `loadProfile()` on every request, so a conflicted
`profile.json` takes the Profile page and the whole tailoring path down with a
JSON parse error until you fix it. Don't hand-merge it - take the copy you saved:

```bash
cp ~/profile.vm.json config/profile.json
git stash drop      # a conflicted pop KEEPS the stash entry; this clears it
```

Then `docker compose restart web`.

The tidier long-term fix is to stop editing the profile in two places - either edit
it only on the VM through the UI and `git pull` never touches it, or edit it only on
your laptop, commit it, and treat the VM as read-only. Pick one.

`config/settings.json` (AI keys, Telegram, schedule) is git-ignored, so it is never
part of this - it just sits on the VM's disk through the bind mount and survives
every rebuild.

### What the rebuild does and doesn't handle

- **Schema changes are automatic.** `web/server.js` runs the migration on boot, and
  `db/schema.sql` is written to be idempotent (`CREATE TABLE IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`), so a restart is the whole migration step. Nothing to run
  by hand.
- **New dependencies are automatic**, but only because `package.json` changing
  invalidates the Docker layer cache and re-runs `npm install`. That's also why a
  dependency change makes the build slow and everything else makes it fast.
- **New `.env` variables are NOT automatic.** `.env` is git-ignored, so a `git pull`
  brings you a new `.env.example` and leaves your `.env` alone. After any update that
  touches it, diff the two and copy across anything new:
  ```bash
  diff <(grep -oE '^[A-Z_]+=' .env.example | sort -u) <(grep -oE '^[A-Z_]+=' .env | sort -u)
  ```
  Lines prefixed `<` are in `.env.example` but missing from your `.env`. Most have a
  code default and are safe to ignore; the diff is there so you notice the one that
  doesn't.
- **Your data is untouched.** `pgdata` is a named volume and `out/` is a bind mount;
  neither is rebuilt. `docker compose down` is also safe - it's `down -v` that destroys
  the database volume, so don't use that flag unless you mean it.

### If an update breaks something

Compose keeps no history, so roll back with git and rebuild:

```bash
git log --oneline -5           # find the commit that was working
git checkout <good-sha>
docker compose up -d --build --remove-orphans
```

Then `git checkout main` (or your branch) once you've fixed the problem on your
laptop. If the database is the thing that broke, restore the dump from §7:

```bash
gunzip -c backup-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U jobagent jobagent
```

### If you deployed with `scp` instead of git (Option B in §3)

Sync from your laptop, then rebuild on the VM. `--exclude` matters: without it you
overwrite the VM's `.env`, its `config/settings.json`, and its generated resumes with
whatever is on your laptop.

```bash
# from your laptop
rsync -avz --delete   --exclude node_modules --exclude .env --exclude config/settings.json   --exclude out --exclude .git   ./job-agent/ user@<vm-ip>:~/job-agent/

# then on the VM
cd ~/job-agent && docker compose up -d --build --remove-orphans
```

Note `--delete` is what removes files you deleted locally (like `src/index.js`) from
the VM - without it, deleted files linger and you debug a ghost.

## 9. Verifying it worked

In order, because each one rules out a different failure:

```bash
docker compose ps                      # only `db` and `web`; both Up
docker compose logs --tail=30 web      # want: "schema ready", "routine search: ...",
                                       #       "review queue on http://localhost:3000"
curl -s localhost:3000/login.html -o /dev/null -w '%{http_code}
'   # 200 (or 302 to it)
```

Then open the UI through your tunnel (§6) and press **search** once. If the run status
walks `ingest → prefilter → score → notify` and the queue reloads, the whole path -
DB, adapters, LLM key, schedule - is live.

## 10. Day to day

```bash
docker compose ps                 # what's running
docker compose logs -f web        # UI requests AND pipeline output - one process now
docker compose restart web        # bounce the app, leave the DB alone
docker compose down               # stop everything (pgdata volume survives)
```