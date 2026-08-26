# postcoaster-status

The **independent** public status page for PostCoaster — [status.postcoaster.com](https://status.postcoaster.com).

It runs on infrastructure **completely separate from the app's Vercel + Supabase**, so it stays up and stays honest exactly when PostCoaster does not. It never touches the app's database or any secret — it only reads two public endpoints from the outside.

## How it works

```
Cloudflare Worker cron (every ~5 min, worker/index.mjs)
  → probe/snapshot.mjs  fetches  https://app.postcoaster.com/api/status   (rich per-service snapshot)
                        pings    https://app.postcoaster.com/api/healthz  (authoritative "is it reachable")
  → commits snapshot.json to the `data` branch via the GitHub Contents API
GitHub Pages (from `main`) serves index.html + render.js
  → render.js fetches snapshot.json from the `data` branch (raw.githubusercontent.com)
```

The probe + snapshot-building logic is shared: `probe/snapshot.mjs` is a pure, runtime-agnostic module (web-standard `fetch` only, no Node APIs) used by **both** the Cloudflare Worker (`worker/index.mjs`) and the Node CLI (`probe/probe.mjs`).

- If `/api/status` can't be read → the page shows the **last known** services, marked stale.
- If `/api/healthz` fails → the page declares PostCoaster **down** (this is the whole point of hosting it elsewhere).
- The page never falls back to a false "all clear".

## Polling via Cloudflare Worker

The poller is a Cloudflare Worker (`worker/index.mjs`, configured by `wrangler.toml`). A **Cron Trigger** runs it every ~5 minutes; on each run it reads the current `snapshot.json` from the **`data` branch** (for the stale-fallback and the blob `sha`), probes `/api/status` + `/api/healthz`, rebuilds the snapshot with the shared `probe/snapshot.mjs` logic, and commits it back via the GitHub Contents API (`probe: update snapshot [skip ci]`) **only when it is worth committing**.

### Why snapshots go to `data`, not `main`

GitHub Pages is built from `main`. Every push to `main` runs `pages-build-deployment`, which consumes Actions minutes (~1 billed minute per run) and is rate-limited to roughly **10 builds per hour**. Writing the snapshot to `main` therefore billed a Pages rebuild on every status flicker — that was the Actions cost after polling itself had already moved off Actions (issue #3).

The Worker writes to `data`. `render.js` on the published site loads `https://raw.githubusercontent.com/Selley-Enterprises/postcoaster-status/data/snapshot.json`. Local `localhost` / `127.0.0.1` / `[::1]` still reads `./snapshot.json` so `python -m http.server` keeps working. Site-file changes on `main` still rebuild Pages; probe commits do not.

That raw.githubusercontent.com fetch requires the repo to stay **public**. If the repo is ever made private, the published page shows "Snapshot unavailable" — the snapshot is no longer same-origin.

`snapshot.json` on `main` is only a local-dev seed. It freezes at the last merge that touched it and is **not** the live snapshot. `data` grows with each heartbeat / real status change (~24 commits/day, on the order of 13 MB of history per year). That growth is expected; it does not rebuild Pages.

The Worker creates `data` from `main` on the first live write if the branch is missing (it forks the branch **before** reading `snapshot.json`, so it picks up the inherited blob `sha` and the first PUT succeeds). The emergency Actions `probe` workflow checks out the dispatch ref for probe code and `data` into `.data` for the snapshot, then pushes only `snapshot.json` back to `data`.

### Polling every 5 minutes, committing only when it matters

It polls every 5 minutes but does **not** commit every poll. `shouldCommitSnapshot()` in `probe/snapshot.mjs` compares the new snapshot with the committed one **ignoring `polledAt` and per-service `uptime90d`** (a fresh timestamp / a 0.01 uptime tick would otherwise make every poll look like a change). It commits only when:

- something meaningful changed — `overall`, `appReachable`, `source`, `note`, service **state**, or `incidents`; **or**
- the committed snapshot's `polledAt` is older than `HEARTBEAT_MS` (1 hour), so the page never looks abandoned; **or**
- there is no committed snapshot yet.

That keeps `data` history readable (~24 heartbeat commits/day plus real status changes) instead of ~288 commits/day. Because those commits are not on `main`, they do **not** rebuild Pages and do **not** spend Actions minutes. The Node CLI (`probe/probe.mjs`) applies the identical rule before writing the local file, so both runtimes behave the same.

Why a Cloudflare Worker: it keeps the monitor **independent** of the app it watches. Cloudflare's edge is entirely separate from PostCoaster's Vercel + Supabase, so the probe keeps running and the page stays honest when the app is down — the whole reason this repo exists. Polling itself is also free of GitHub Actions billing (Actions bills a rounded-up minute per job; ~5-minute polling used to be the top line on the Actions bill — see issue #3).

### Setup

Two deploy paths — use whichever fits. The git-connected route is what's set up here.

1. **Git-connected deploy (recommended, already configured):** In the Cloudflare dashboard, create the Worker from the **`postcoaster-status`** repo (the git integration / "Continue with GitHub" Workers Builds flow). Cloudflare reads `wrangler.toml` from the repo root and builds + deploys on every push to `main`; the Cron Trigger comes from `[triggers] crons` in `wrangler.toml`.

   > **Connect the `postcoaster-status` repo — NOT the `PostCoaster` app repo.** Building the monitor from the monitored app's repo/infrastructure would couple it to the very stack it's supposed to watch from the outside, defeating the independence goal.

2. **CLI deploy (alternative):** from the repo root, `npx wrangler@latest deploy`.

3. **Give the Worker its own GitHub token.** Connecting the repo to Cloudflare only grants **Cloudflare → read the repo** access (for building/deploying). It does **not** let the running Worker commit `snapshot.json` back. The Worker needs its own **fine-grained GitHub PAT scoped to only this repo with Contents: Read and write**, stored as the `GITHUB_TOKEN` secret:
   - **Dashboard:** Worker → **Settings → Variables and Secrets** → add `GITHUB_TOKEN` as a **Secret**.
   - **CLI:** `npx wrangler secret put GITHUB_TOKEN`.

4. **Config (optional):** non-secret defaults live in `wrangler.toml` `[vars]` — `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` (`data`, not `main`), `POSTCOASTER_APP_URL` (`https://app.postcoaster.com`). Override there if needed. Never put a token in `[vars]`. Never point `GITHUB_BRANCH` at the Pages source branch.

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
5. **Seed the `data` branch:** the Worker creates it on first write if needed. To seed by hand: `git branch data main && git push origin data`. The cron then updates `data` within ~5 minutes. The emergency **probe** workflow can refresh `snapshot.json` on an existing `data` branch; it cannot create the branch (its checkout of `ref: data` fails if `data` is missing). (There is no public Worker URL to hit — `workers_dev = false`; on-demand HTTP runs need a route plus `PROBE_TRIGGER_SECRET`, see above.)

## Local development

```bash
node probe/probe.mjs                 # probes the live app; writes snapshot.json only if it changed
python -m http.server 8080           # or any static server; open http://localhost:8080

# run the tests (list the files explicitly — `node --test probe/` is broken on Node 22)
node --test probe/probe.test.mjs probe/page.test.mjs probe/snapshot.test.mjs worker/index.test.mjs
```

## What it does NOT do

- No database, no secrets, no write access to PostCoaster.
- Incidents/maintenance are declared from Mission Control inside the app (operators); this page just reflects the published snapshot.
- Uptime figures come from the app's own status snapshot (`uptime90d` per service).
