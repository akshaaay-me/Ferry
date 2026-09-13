# Deploying job-agent to a VM

Goal: `agent` (ingest → prefilter → score → notify, on the `INGEST_CRON` schedule)
and `web` (the review queue) run continuously on a small VM, survive reboots
and crashes, and the review UI is reachable by you only. It does have its own
login now (§6), but that's a single email/password pair, not a real access
layer - the port itself must still never sit on the open internet.

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
to be public; §5 covers how you'll still reach the review UI.

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
nano .env    # fill in ANTHROPIC_API_KEY at minimum; TELEGRAM_* if you want push notifications
```

`docker-compose.yml` already points `DATABASE_URL` at the `db` container for
you inside Docker - the `DATABASE_URL` line in `.env` only matters if you
ever run the pipeline outside Docker.

The AI provider block (`ANTHROPIC_API_KEY` / `LLM_PROVIDER` / `LLM_*`) can also
be left blank here and set later from the Settings page (`/settings.html`)
once `web` is up - it writes to `config/settings.json`, which `docker-compose.yml`
already bind-mounts (`./config:/app/config`, same as `profile.json`), so no
redeploy is needed either way.

## 5. Start it

```bash
docker compose up -d --build
docker compose logs -f agent   # watch the first cycle: ingest, prefilter, score, notify
```

`agent`'s entrypoint (`src/index.js`) runs the DB migration itself on boot,
so there's no separate migrate step to remember when running under Compose.

Both `db` and `web`'s ports are bound to `127.0.0.1` in `docker-compose.yml`
(already set up this way) - reachable from the VM itself, not from the
internet. All three services also carry `restart: unless-stopped`, so Docker
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
- the app's own login (§6) is one shared credential pair, not real access
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

## 8. Updating

```bash
git pull                       # if you're using git
docker compose up -d --build   # rebuilds only what changed, restarts the rest
```

## 9. Day to day

```bash
docker compose ps                 # what's running
docker compose logs -f agent      # pipeline output, live
docker compose logs -f web        # review UI requests
docker compose restart agent      # bounce just one service
docker compose down               # stop everything (pgdata volume survives)
```