// postcoaster-status — external probe.
//
// Runs on GitHub Actions (independent of PostCoaster's Vercel + Supabase). Polls
// the app's PUBLIC, already-sanitized endpoints from the outside and writes a
// snapshot the static page renders:
//   GET /api/status   — the rich per-service snapshot the app computes
//   GET /api/healthz  — a crisp liveness probe (authoritative "is it reachable")
//
// It never touches the app's database or any secret. When /api/status can't be
// reached it keeps the last-known services and marks the page stale, and when
// /api/healthz fails it declares the app down — so the status page stays honest
// exactly when the app is not.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, '..', 'snapshot.json');
const APP_URL = (process.env.POSTCOASTER_APP_URL || 'https://app.postcoaster.com').replace(/\/+$/, '');
const TIMEOUT_MS = 10_000;

const STATE_RANK = { operational: 0, maintenance: 1, degraded: 2, down: 3 };
const worst = (a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a);

// Pure: fold the two probe results (+ the previous snapshot) into the next one.
// Exported for tests.
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

async function fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'postcoaster-status-probe' } });
  } finally {
    clearTimeout(t);
  }
}

async function probeStatus() {
  try {
    const res = await fetchWithTimeout(`${APP_URL}/api/status`);
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

async function probeHealth() {
  try {
    const res = await fetchWithTimeout(`${APP_URL}/api/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const [statusResult, healthOk, previous] = await Promise.all([probeStatus(), probeHealth(), readPrevious()]);
  const snapshot = buildMonitorSnapshot({ statusResult, healthOk, previous, now: Date.now() });
  await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(`[probe] ${APP_URL} → overall=${snapshot.overall} reachable=${snapshot.appReachable} source=${snapshot.source}`);
}

// Only run when invoked directly (tests import buildMonitorSnapshot).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('[probe] failed:', err); process.exit(1); });
}
