# postcoaster-status

The **independent** public status page for PostCoaster — [status.postcoaster.com](https://status.postcoaster.com).

It runs on GitHub's infrastructure, **completely separate from the app's Vercel + Supabase**, so it stays up and stays honest exactly when PostCoaster does not. It never touches the app's database or any secret — it only reads two public endpoints from the outside.

## How it works

```
GitHub Actions cron (every ~5 min)
  → probe/probe.mjs  fetches  https://app.postcoaster.com/api/status   (rich per-service snapshot)
                     pings    https://app.postcoaster.com/api/healthz  (authoritative "is it reachable")
  → writes snapshot.json, commits it
GitHub Pages serves index.html + render.js, which renders snapshot.json.
```

- If `/api/status` can't be read → the page shows the **last known** services, marked stale.
- If `/api/healthz` fails → the page declares PostCoaster **down** (this is the whole point of hosting it elsewhere).
- The page never falls back to a false "all clear".

## One-time setup

1. **Create the repo — make it PUBLIC.** A public repo gets free, unlimited Actions minutes, so the probe cron runs regardless of the main org's Actions quota. Nothing here is secret (it only calls public endpoints).
   ```
   gh repo create Selley-Enterprises/postcoaster-status --public --source . --push
   ```
2. **Enable Pages:** repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)`**.
3. **Custom domain:** the `CNAME` file already declares `status.postcoaster.com`. In **Settings → Pages → Custom domain** confirm it, then add a DNS record at your provider:
   ```
   status.postcoaster.com  CNAME  <your-github-username-or-org>.github.io
   ```
   Enable **Enforce HTTPS** once the cert issues.
4. **Point it at the app (optional):** defaults to `https://app.postcoaster.com`. To override, set an Actions **variable** `POSTCOASTER_APP_URL` (Settings → Secrets and variables → Actions → Variables).
5. **Seed it:** Actions tab → **probe** workflow → **Run workflow** once. It writes the first live `snapshot.json`. After that the cron keeps it fresh.

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
