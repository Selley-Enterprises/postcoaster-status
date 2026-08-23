// postcoaster-status — shared, runtime-agnostic probe + snapshot logic.
//
// Pure web-standard APIs only (`fetch`, `AbortController`, `Date`) — no
// `node:fs`/`node:path` — so this module runs unchanged both in the Node CLI
// (probe/probe.mjs) and in the Cloudflare Worker (worker/index.mjs).
//
// It polls the app's PUBLIC, already-sanitized endpoints from the outside:
//   GET /api/status   — the rich per-service snapshot the app computes
//   GET /api/healthz  — a crisp liveness probe (authoritative "is it reachable")
// and folds the results (plus the previous snapshot) into the next snapshot.
// It never touches the app's database or any secret.

export const DEFAULT_APP_URL = 'https://app.postcoaster.com';
export const TIMEOUT_MS = 10_000;

// How stale the committed snapshot may get before we re-commit it even though
// nothing meaningful changed. The page shows `polledAt`, so without a heartbeat
// a long healthy stretch would make the monitor look abandoned. At a 5-minute
// poll this caps writes at ~24 commits/day instead of ~288 (one per poll), which
// keeps us far under GitHub Pages' build-rate limits.
export const HEARTBEAT_MS = 60 * 60 * 1000; // 1 hour

const STATE_RANK = { operational: 0, maintenance: 1, degraded: 2, down: 3 };
const worst = (a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a);

// Normalize an app URL: strip trailing slashes.
export const normalizeAppUrl = (url) => (url || DEFAULT_APP_URL).replace(/\/+$/, '');

// Pure: fold the two probe results (+ the previous snapshot) into the next one.
// Exported for tests and reuse.
export function buildMonitorSnapshot({ statusResult, healthOk, previous, now }) {
  const iso = new Date(now).toISOString();
  const live = statusResult && statusResult.ok && statusResult.snapshot;

  let services = live ? statusResult.snapshot.services : (previous?.services ?? []);
  let incidents = live ? statusResult.snapshot.incidents : (previous?.incidents ?? []);
  let overall = live ? statusResult.snapshot.overall : 'operational';
  let source = live ? 'live' : 'stale';
  let note = null;

  if (!healthOk) {
    // The app is not answering its liveness probe — that's a real outage, and
    // the most important thing this page exists to say.
    overall = 'down';
    note = 'PostCoaster is not responding. We are aware and investigating.';
    source = live ? 'live' : 'stale';
  } else if (!live) {
    // Reachable, but we couldn't read the detailed status — show last-known and
    // flag it as possibly out of date rather than silently reporting all-clear.
    overall = worst(overall, 'degraded');
    note = 'Showing the last known status — live detail is temporarily unavailable.';
  }

  return {
    polledAt: iso,
    appReachable: Boolean(healthOk),
    source,
    overall,
    note,
    services: Array.isArray(services) ? services : [],
    incidents: Array.isArray(incidents) ? incidents : [],
  };
}

// --- Change detection -------------------------------------------------------
//
// `polledAt` is a fresh timestamp on every run, so comparing serialized
// snapshots byte-for-byte always reports "changed" and commits on every poll.
// Everything else in the snapshot — `source`, `overall`, `appReachable`,
// `note`, `services`, `incidents` — is meaningful and must be compared.

// Stable, order-insensitive serialization so key ordering (e.g. a re-parsed
// snapshot.json vs. a freshly built object) never registers as a change.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

// A string identity for a snapshot that deliberately ignores `polledAt`.
// Returns null for anything that isn't a snapshot-shaped object.
export function snapshotFingerprint(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { polledAt, ...meaningful } = snapshot;
  return JSON.stringify(canonicalize(meaningful));
}

// True when the two snapshots differ in anything a reader would care about.
// A missing/unparseable previous snapshot counts as different.
export function isMeaningfullyDifferent(previous, next) {
  const before = snapshotFingerprint(previous);
  const after = snapshotFingerprint(next);
  if (before === null || after === null) return true;
  return before !== after;
}

// The single commit rule shared by the Worker and the Node CLI: write IF there
// is no previous snapshot, OR something meaningful changed, OR the previous
// snapshot's `polledAt` is older than the heartbeat threshold.
export function shouldCommitSnapshot({ previous, next, now = Date.now(), heartbeatMs = HEARTBEAT_MS } = {}) {
  if (!previous || typeof previous !== 'object') return { commit: true, reason: 'no-previous-snapshot' };
  if (isMeaningfullyDifferent(previous, next)) return { commit: true, reason: 'changed' };

  const previousPolledAt = Date.parse(previous.polledAt ?? '');
  if (!Number.isFinite(previousPolledAt)) return { commit: true, reason: 'previous-polledAt-unreadable' };
  if (now - previousPolledAt >= heartbeatMs) return { commit: true, reason: 'heartbeat' };

  return { commit: false, reason: 'unchanged' };
}

async function fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'postcoaster-status-probe' } });
  } finally {
    clearTimeout(t);
  }
}

export async function probeStatus(appUrl = DEFAULT_APP_URL) {
  const base = normalizeAppUrl(appUrl);
  try {
    const res = await fetchWithTimeout(`${base}/api/status`);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json();
    // /api/status wraps the snapshot as { ok, ...snapshot } or { ...snapshot }.
    const snapshot = body && Array.isArray(body.services) ? body : (body?.snapshot ?? null);
    if (!snapshot || !Array.isArray(snapshot.services)) return { ok: false, reason: 'unexpected shape' };
    return { ok: true, snapshot };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  }
}

export async function probeHealth(appUrl = DEFAULT_APP_URL) {
  const base = normalizeAppUrl(appUrl);
  try {
    const res = await fetchWithTimeout(`${base}/api/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

// Convenience: probe both endpoints and build the next snapshot in one call.
// `previous` is the last-known snapshot (or null); `now` defaults to Date.now().
export async function probeAndBuild({ appUrl = DEFAULT_APP_URL, previous = null, now = Date.now() } = {}) {
  const [statusResult, healthOk] = await Promise.all([probeStatus(appUrl), probeHealth(appUrl)]);
  return buildMonitorSnapshot({ statusResult, healthOk, previous, now });
}
