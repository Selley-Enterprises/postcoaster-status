// postcoaster-status — Cloudflare Worker poller.
//
// Replaces the GitHub Actions cron as the poller (see issue #3), while
// preserving the monitor's independence: it runs on Cloudflare, entirely
// separate from PostCoaster's Vercel + Supabase. On a Cron Trigger it probes the
// app's public endpoints, builds the snapshot with the SHARED, runtime-agnostic
// logic in ../probe/snapshot.mjs, and commits snapshot.json back to this repo via
// the GitHub Contents API — so the static GitHub Pages page is unchanged (it
// still reads same-origin ./snapshot.json).
//
// Config comes from `env`:
//   GITHUB_TOKEN         (secret)  fine-grained PAT, Contents: Read and write, THIS repo only
//   GITHUB_OWNER         default "Selley-Enterprises"
//   GITHUB_REPO          default "postcoaster-status"
//   GITHUB_BRANCH        default "main"
//   POSTCOASTER_APP_URL  default "https://app.postcoaster.com"

import { DEFAULT_APP_URL, buildMonitorSnapshot, probeHealth, probeStatus } from '../probe/snapshot.mjs';

const SNAPSHOT_PATH = 'snapshot.json';
const COMMIT_MESSAGE = 'probe: update snapshot [skip ci]';
const COMMITTER = { name: 'status-probe', email: 'status-probe@users.noreply.github.com' };
const USER_AGENT = 'postcoaster-status-probe';

function config(env = {}) {
  return {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER || 'Selley-Enterprises',
    repo: env.GITHUB_REPO || 'postcoaster-status',
    branch: env.GITHUB_BRANCH || 'main',
    appUrl: env.POSTCOASTER_APP_URL || DEFAULT_APP_URL,
  };
}

// UTF-8-safe base64 using web-standard APIs (no Buffer).
function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Read the current snapshot.json to recover the previous snapshot (for the
// stale-fallback) AND its blob sha (needed to update the file). Missing file is
// a valid first-run state.
async function getExistingSnapshot({ owner, repo, branch, token }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${SNAPSHOT_PATH}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (res.status === 404) return { sha: null, previous: null, raw: null };
  if (!res.ok) throw new Error(`GitHub GET contents failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  const raw = typeof body.content === 'string' ? decodeBase64(body.content) : null;
  let previous = null;
  try {
    previous = raw ? JSON.parse(raw) : null;
  } catch {
    previous = null;
  }
  return { sha: body.sha || null, previous, raw };
}

async function putSnapshot({ owner, repo, branch, token, sha, content }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${SNAPSHOT_PATH}`;
  const payload = {
    message: COMMIT_MESSAGE,
    content: encodeBase64(content),
    branch,
    committer: COMMITTER,
    author: COMMITTER,
  };
  if (sha) payload.sha = sha;
  const res = await fetch(url, { method: 'PUT', headers: ghHeaders(token), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`GitHub PUT contents failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// The one routine both the cron and the on-demand fetch handler run.
async function runProbe(env) {
  const cfg = config(env);
  if (!cfg.token) throw new Error('GITHUB_TOKEN is not configured (set it as a Worker secret).');

  const [{ sha, previous, raw }, statusResult, healthOk] = await Promise.all([
    getExistingSnapshot(cfg),
    probeStatus(cfg.appUrl),
    probeHealth(cfg.appUrl),
  ]);

  const snapshot = buildMonitorSnapshot({ statusResult, healthOk, previous, now: Date.now() });
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  // Only commit when the serialized snapshot actually changed. Compare against
  // the raw bytes so noise (e.g. only polledAt drift) still updates, but an
  // identical file is skipped.
  if (raw !== null && raw === serialized) {
    return { changed: false, overall: snapshot.overall, appReachable: snapshot.appReachable, source: snapshot.source };
  }

  await putSnapshot({ ...cfg, sha, content: serialized });
  return { changed: true, overall: snapshot.overall, appReachable: snapshot.appReachable, source: snapshot.source };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runProbe(env).then(
        (result) => console.log(`[probe] scheduled → ${JSON.stringify(result)}`),
        (err) => console.error('[probe] scheduled failed:', err),
      ),
    );
  },

  async fetch(request, env, ctx) {
    // On-demand run (wrangler dev / manual GET) of the same routine. Safe: it
    // only reads public endpoints and commits snapshot.json with the configured
    // token; there is nothing secret to leak in the response.
    try {
      const result = await runProbe(env);
      return new Response(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      return new Response(`${JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2)}\n`, {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  },
};
