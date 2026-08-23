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
//   PROBE_TRIGGER_SECRET (secret, OPTIONAL) shared secret required by the HTTP
//                        handler to commit. Unset → HTTP runs dry-run only.
//
// The cron path always commits and needs no secret. The HTTP handler is the only
// caller-controlled entry point, so it is gated (see `fetch` below), and
// `workers_dev = false` in wrangler.toml means there is no public URL by default.

import {
  DEFAULT_APP_URL,
  buildMonitorSnapshot,
  probeHealth,
  probeStatus,
  shouldCommitSnapshot,
} from '../probe/snapshot.mjs';

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
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Reads work unauthenticated on this public repo, which keeps dry-runs useful
  // even when no token is configured. Writes always require the token.
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Constant-time string comparison (no `node:crypto` — this must run on
// Cloudflare's runtime). Length is compared into the same accumulator and the
// loop always walks the longer of the two, so a wrong secret takes the same
// path regardless of where it first differs.
function secretsMatch(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(typeof a === 'string' ? a : '');
  const right = encoder.encode(typeof b === 'string' ? b : '');
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0 && left.length > 0;
}

// Accept either `Authorization: Bearer <secret>` or `X-Probe-Secret: <secret>`.
function presentedSecret(request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer) return bearer[1].trim();
  const header = request.headers.get('x-probe-secret');
  return header ? header.trim() : '';
}

function jsonResponse(body, status = 200) {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
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
// `dryRun` probes and computes the snapshot but never writes to the repo.
async function runProbe(env, { dryRun = false } = {}) {
  const cfg = config(env);
  if (!cfg.token && !dryRun) throw new Error('GITHUB_TOKEN is not configured (set it as a Worker secret).');

  const now = Date.now();
  const [{ sha, previous }, statusResult, healthOk] = await Promise.all([
    getExistingSnapshot(cfg),
    probeStatus(cfg.appUrl),
    probeHealth(cfg.appUrl),
  ]);

  const snapshot = buildMonitorSnapshot({ statusResult, healthOk, previous, now });
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  // `polledAt` is fresh every run, so byte comparison would always differ and we
  // would commit ~288 times a day. Commit only on a meaningful change, on the
  // hourly heartbeat, or when there is no previous snapshot at all.
  const { commit, reason } = shouldCommitSnapshot({ previous, next: snapshot, now });
  const result = {
    committed: false,
    reason,
    dryRun,
    overall: snapshot.overall,
    appReachable: snapshot.appReachable,
    source: snapshot.source,
    polledAt: snapshot.polledAt,
    snapshot,
  };

  if (!commit || dryRun) return result;

  await putSnapshot({ ...cfg, sha, content: serialized });
  return { ...result, committed: true };
}

export default {
  // The cron is the normal path: it is not caller-controlled, so it needs no
  // secret and always commits under the rule above.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runProbe(env).then(
        ({ snapshot, ...summary }) => console.log(`[probe] scheduled → ${JSON.stringify(summary)}`),
        (err) => console.error('[probe] scheduled failed:', err),
      ),
    );
  },

  // On-demand run (wrangler dev / manual GET). This is a WRITE endpoint, so it
  // is gated:
  //   * PROBE_TRIGGER_SECRET unset → dry-run only; probe and report, never commit.
  //   * set → caller must present it as `Authorization: Bearer <secret>` or
  //     `X-Probe-Secret: <secret>`, else 401 with no probe and no commit.
  //   * `?dryRun=1` → probe but never commit, even when authorized.
  async fetch(request, env) {
    const url = new URL(request.url);
    const dryRunParam = (url.searchParams.get('dryRun') || '').toLowerCase();
    const explicitDryRun = dryRunParam === '1' || dryRunParam === 'true' || dryRunParam === 'yes';

    const secret = env?.PROBE_TRIGGER_SECRET;
    let dryRun = explicitDryRun;
    let reason = explicitDryRun ? 'dryRun requested' : null;

    if (typeof secret !== 'string' || secret.length === 0) {
      dryRun = true;
      reason = explicitDryRun ? reason : 'PROBE_TRIGGER_SECRET not configured';
    } else if (!secretsMatch(presentedSecret(request), secret)) {
      return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
    }

    try {
      const { snapshot, reason: commitReason, ...summary } = await runProbe(env, { dryRun });
      return jsonResponse({ ok: true, ...summary, commitReason, ...(reason ? { reason } : {}), snapshot });
    } catch (err) {
      return jsonResponse({ ok: false, dryRun, error: String(err?.message || err) }, 500);
    }
  },
};
