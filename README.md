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

The poller is a Cloudflare Worker (`worker/index.mjs`, configured by `wrangler.toml`). A **Cron Trigger** runs it every ~5 minutes; on each run it reads the current `snapshot.json` from this repo (for the stale-fallback and the blob `sha`), probes `/api/status` + `/api/healthz`, rebuilds the snapshot with the shared `probe/snapshot.mjs` logic, and commits it back via the GitHub Contents API (`probe: update snapshot [skip ci]`) **only when it is worth committing**.

### Polling every 5 minutes, committing at most hourly

It polls every 5 minutes but does **not** commit every poll. `shouldCommitSnapshot()` in `probe/snapshot.mjs` compares the new snapshot with the committed one **ignoring `polledAt`** (which is a fresh timestamp on every run and would otherwise make every poll look like a change). It commits only when:

- something meaningful changed — `overall`, `appReachable`, `source`, `note`, `services` or `incidents`; **or**
- the committed snapshot's `polledAt` is older than `HEARTBEAT_MS` (1 hour), so the page never looks abandoned; **or**
- there is no committed snapshot yet.

That caps writes at ~24 commits/day instead of ~288 (one per poll). This is deliberate: every commit to `main` triggers a **GitHub Pages build**, and Pages enforces a soft limit of roughly **10 builds per hour** — polling-rate commits would blow through it, delay the page updates that actually matter, and churn the repo history. The Node CLI (`probe/probe.mjs`) applies the identical rule before writing the local file, so both runtimes behave the same.

Why a Cloudflare Worker: it keeps the monitor **independent** of the app it watches. Cloudflare's edge is entirely separate from PostCoaster's Vercel + Supabase, so the probe keeps running and the page stays honest when the app is down — the whole reason this repo exists. It also frees the polling from GitHub Actions billing (Actions bills a rounded-up minute per job; ~5-minute polling was the top line on the Actions bill — see issue #3).

### Setup

Two deploy paths — use whichever fits. The git-connected route is what's set up here.

1. **Git-connected deploy (recommended, already configured):** In the Cloudflare dashboard, create the Worker from the **`postcoaster-status`** repo (the git integration / "Continue with GitHub" Workers Builds flow). Cloudflare reads `wrangler.toml` from the repo root and builds + deploys on every push to `main`; the Cron Trigger comes from `[triggers] crons` in `wrangler.toml`.

   > **Connect the `postcoaster-status` repo — NOT the `PostCoaster` app repo.** Building the monitor from the monitored app's repo/infrastructure would couple it to the very stack it's supposed to watch from the outside, defeating the independence goal.

2. **CLI deploy (alternative):** from the repo root, `npx wrangler@latest deploy`.

3. **Give the Worker its own GitHub token.** Connecting the repo to Cloudflare only grants **Cloudflare → read the repo** access (for building/deploying). It does **not** let the running Worker commit `snapshot.json` back. The Worker needs its own **fine-grained GitHub PAT scoped to only this repo with Contents: Read and write**, stored as the `GITHUB_TOKEN` secret:
   - **Dashboard:** Worker → **Settings → Variables and Secrets** → add `GITHUB_TOKEN` as a **Secret**.
   - **CLI:** `npx wrangler secret put GITHUB_TOKEN`.

4. **Config (optional):** non-secret defaults live in `wrangler.toml` `[vars]` — `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` (`main`), `POSTCOASTER_APP_URL` (`https://app.postcoaster.com`). Override there if needed. Never put a token in `[vars]`.

5. **`PROBE_TRIGGER_SECRET` (optional secret) — on-demand HTTP runs.** The **cron is the normal path** and needs no secret. `wrangler.toml` sets `workers_dev = false`, so the Worker has **no public URL** by default. The Worker's `fetch()` handler is nonetheless a *write* path (it commits `snapshot.json`), so it is gated:

   - **Secret not set (default):** `fetch()` is **dry-run only** — it probes and returns the computed snapshot as JSON, but never commits (`{"dryRun": true, "reason": "PROBE_TRIGGER_SECRET not configured"}`).
   - **Secret set:** the caller must present it as `Authorization: Bearer <secret>` or `X-Probe-Secret: <secret>` (compared in constant time). Anything else gets `401` and no probe and no commit.
   - `?dryRun=1` always probes without committing, even when authorized.

   Set it only if you want to force a commit on demand: `npx wrangler secret put PROBE_TRIGGER_SECRET` (dashboard: Worker → **Settings → Variables and Secrets** → add as a **Secret**). Enabling a `workers.dev` URL or a route without this secret set would leave an anonymous, unauthenticated write endpoint exposed.

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
5. **Seed it:** once the Cloudflare Worker is deployed (see above), its cron writes the first live `snapshot.json` within ~5 minutes. (There is no public Worker URL to hit — `workers_dev = false`; on-demand HTTP runs need a route plus `PROBE_TRIGGER_SECRET`, see above.) For a one-off without the Worker, run the **probe** workflow manually (Actions tab → **probe** → **Run workflow**).

## Local development

```bash
node probe/probe.mjs                 # probes the live app; writes snapshot.json only if it changed
python -m http.server 8080           # or any static server; open http://localhost:8080

# run the tests (list the files explicitly — `node --test probe/` is broken on Node 22)
node --test probe/probe.test.mjs probe/page.test.mjs probe/snapshot.test.mjs
```

## What it does NOT do

- No database, no secrets, no write access to PostCoaster.
- Incidents/maintenance are declared from Mission Control inside the app (operators); this page just reflects the published snapshot.
- Uptime figures come from the app's own status snapshot (`uptime90d` per service).
