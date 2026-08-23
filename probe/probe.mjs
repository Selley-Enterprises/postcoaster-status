// postcoaster-status — external probe (Node CLI).
//
// Historically ran on GitHub Actions; polling now runs on an independent
// Cloudflare Worker (see worker/index.mjs). This CLI stays available for local
// development and manual `workflow_dispatch` seeding. It polls the app's PUBLIC,
// already-sanitized endpoints from the outside and writes a snapshot the static
// page renders:
//   GET /api/status   — the rich per-service snapshot the app computes
//   GET /api/healthz  — a crisp liveness probe (authoritative "is it reachable")
//
// It never touches the app's database or any secret. When /api/status can't be
// reached it keeps the last-known services and marks the page stale, and when
// /api/healthz fails it declares the app down — so the status page stays honest
// exactly when the app is not.
//
// The runtime-agnostic probe + snapshot logic lives in ./snapshot.mjs (shared
// with the Worker). This file keeps only the node-specific parts: reading and
// writing the local snapshot.json and CLI orchestration.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULT_APP_URL,
  buildMonitorSnapshot,
  normalizeAppUrl,
  probeHealth,
  probeStatus,
  shouldCommitSnapshot,
} from './snapshot.mjs';

// Re-export the pure snapshot builder so existing importers/tests keep working.
export { buildMonitorSnapshot };

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, '..', 'snapshot.json');
const APP_URL = normalizeAppUrl(process.env.POSTCOASTER_APP_URL || DEFAULT_APP_URL);

async function readPrevious() {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const now = Date.now();
  const [statusResult, healthOk, previous] = await Promise.all([probeStatus(APP_URL), probeHealth(APP_URL), readPrevious()]);
  const snapshot = buildMonitorSnapshot({ statusResult, healthOk, previous, now });

  // Same rule as the Worker: skip the write unless something meaningful changed
  // (`polledAt` alone does not count) or the heartbeat is due — so a run that
  // finds no news leaves the file, and the repo history, untouched.
  const { commit, reason } = shouldCommitSnapshot({ previous, next: snapshot, now });
  if (commit) await writeFile(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  console.log(
    `[probe] ${APP_URL} → overall=${snapshot.overall} reachable=${snapshot.appReachable} source=${snapshot.source} ` +
      `${commit ? 'written' : 'skipped'} (${reason})`,
  );
}

// Only run when invoked directly (tests import buildMonitorSnapshot).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('[probe] failed:', err); process.exit(1); });
}
