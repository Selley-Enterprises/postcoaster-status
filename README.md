# postcoaster-status

The **independent** public status page for PostCoaster — [status.postcoaster.com](https://status.postcoaster.com).

It runs on infrastructure **completely separate from the app's Vercel + Supabase**, so it stays up and stays honest exactly when PostCoaster does not. It never touches the app's database or any secret — it only reads two public endpoints from the outside.

## How it works

```
Cloudflare Worker cron (every ~5 min, worker/index.mjs)
  → probe/snapshot.mjs  fetches  https://app.postcoaster.com/api/status   (rich per-service snapshot)
                        pings    https://app.postcoaster.com/api/healthz  (authoritative "is it reachable")
  → commits snapshot.json back to this repo via the GitHub Contents API
GitHub Pages serves index.html + render.js, which renders snapshot.json.
```

The probe + snapshot-building logic is shared: `probe/snapshot.mjs` is a pure, runtime-agnostic module (web-standard `fetch` only, no Node APIs) used by **both** the Cloudflare Worker (`worker/index.mjs`) and the Node CLI (`probe/probe.mjs`).

- If `/api/status` can't be read → the page shows the **last known** services, marked stale.
- If `/api/healthz` fails → the page declares PostCoaster **down** (this is the whole point of hosting it elsewhere).
- The page never falls back to a false "all clear".

## Polling via Cloudflare Worker

The poller is a Cloudflare Worker (`worker/index.mjs`, configured by `wrangler.toml`). A **Cron Trigger** runs it every ~5 minutes; on each run it reads the current `snapshot.json` from this repo (for the stale-fallback and the blob `sha`), probes `/api/status` + `/api/healthz`, rebuilds the snapshot with the shared `probe/snapshot.mjs` logic, and — only if the file changed — commits it back via the GitHub Contents API (`probe: update snapshot [skip ci]`).

Why a Cloudflare Worker: it keeps the monitor **independent** of the app it watches. Cloudflare's edge is entirely separate from PostCoaster's Vercel + Supabase, so the probe keeps running and the page stays honest when the app is down — the whole reason this repo exists. It also frees the polling from GitHub Actions billing (Actions bills a rounded-up minute per job; ~5-minute polling was the top line on the Actions bill — see issue #3).

### Setup

Two deploy paths — use whichever fits. The git-connected route is what's set up here.

1. **Git-connected deploy (recommended, already configured):** In the Cloudflare dashboard, create the Worker from the **`postcoaster-status`** repo (the git integration / "Continue with GitHub" Workers Builds flow). Cloudflare reads `wrangler.toml` from the repo root and builds + deploys on every push to `main`; the Cron Trigger comes from `[triggers] crons` in `wrangler.toml`.

   > **Connect the `postcoaster-status` repo — NOT the `PostCoaster` app repo.** Building the monitor from the monitored app's repo/infrastructure would couple it to the very stack it's supposed to watch from the outside, defeating the independence goal.

2. **CLI deploy (alternative):** from the repo root, `npx wrangler@latest deploy`.

3. **Give the Worker its own GitHub token.** Connecting the repo to Cloudflare only grants **Cloudflare → read the repo** access (for building/deploying). It does **not** let the running Worker commit `snapshot.json` back. The Worker needs its own **fine-grained GitHub PAT scoped to only this repo with Contents: Read and write**, stored as the `GITHUB_TOKEN` secret:
   - **Dashboard:** Worker → **Settings → Variables and Secrets** → add `GITHUB_TOKEN` as a **Secret**.
   - **CLI:** `npx wrangler secret put GITHUB_TOKEN`.

4. **Config (optional):** non-secret defaults live in `wrangler.toml` `[vars]` — `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` (`main`), `POSTCOASTER_APP_URL` (`https://app.postcoaster.com`). Override there if needed. Never put the token in `[vars]`.

The cron cadence is `*/5 * * * *` (every 5 minutes). The GitHub Action **no longer polls** — it's kept for manual `workflow_dispatch` seeding / emergencies only.

## One-time setup (GitHub Pages)

1. **Create the repo — make it PUBLIC.** Nothing here is secret (it only calls public endpoints), and a public repo is required for free GitHub Pages hosting. Polling itself no longer runs on Actions (see [Polling via Cloudflare Worker](#polling-via-cloudflare-worker)).
   ```
   gh repo create Selley-Enterprises/postcoaster-status --public --source . --push
   ```
2. **Enable Pages:** repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)`**.
3. **Custom domain:** the `CNAME` file already declares `status.postcoaster.com`. In **Settings → Pages → Custom domain** confirm it, then add a DNS record at your provider:
   ```
   status.postcoaster.com  CNAME  <your-github-username-or-org>.github.io
   ```
   Enable **Enforce HTTPS** once the cert issues.
4. **Point it at the app (optional):** defaults to `https://app.postcoaster.com`. To override for the Cloudflare Worker, set `POSTCOASTER_APP_URL` in `wrangler.toml` `[vars]`; for the manual Actions run, set an Actions **variable** `POSTCOASTER_APP_URL` (Settings → Secrets and variables → Actions → Variables).
5. **Seed it:** once the Cloudflare Worker is deployed (see above), its cron writes the first live `snapshot.json` within ~5 minutes; you can also trigger it on demand via the Worker's URL. For a one-off without the Worker, run the **probe** workflow manually (Actions tab → **probe** → **Run workflow**).

## Local development

```bash
node probe/probe.mjs                 # writes snapshot.json from the live app
python -m http.server 8080           # or any static server; open http://localhost:8080
node --test probe/                   # run the probe tests
```

## What it does NOT do

- No database, no secrets, no write access to PostCoaster.
- Incidents/maintenance are declared from Mission Control inside the app (operators); this page just reflects the published snapshot.
- Uptime figures come from the app's own status snapshot (`uptime90d` per service).
