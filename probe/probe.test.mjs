import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMonitorSnapshot } from './probe.mjs';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const liveSnapshot = {
  overall: 'operational',
  services: [{ key: 'app', label: 'PostCoaster app', state: 'operational', uptime90d: 99.98 }],
  incidents: [],
};

test('live + healthy → reports the app snapshot as-is', () => {
  const s = buildMonitorSnapshot({ statusResult: { ok: true, snapshot: liveSnapshot }, healthOk: true, previous: null, now: NOW });
  assert.equal(s.overall, 'operational');
  assert.equal(s.source, 'live');
  assert.equal(s.appReachable, true);
  assert.equal(s.note, null);
  assert.equal(s.services[0].key, 'app');
});

test('health probe fails → declares the app DOWN regardless of cached detail', () => {
  const s = buildMonitorSnapshot({ statusResult: { ok: true, snapshot: liveSnapshot }, healthOk: false, previous: null, now: NOW });
  assert.equal(s.overall, 'down');
  assert.equal(s.appReachable, false);
  assert.match(s.note, /not responding/i);
});

test('reachable but /api/status unreadable → last-known services, marked stale + degraded', () => {
  const previous = { services: [{ key: 'app', label: 'PostCoaster app', state: 'operational', uptime90d: 99.9 }], incidents: [{ id: 'i1' }] };
  const s = buildMonitorSnapshot({ statusResult: { ok: false, reason: 'timeout' }, healthOk: true, previous, now: NOW });
  assert.equal(s.source, 'stale');
  assert.equal(s.overall, 'degraded');
  assert.equal(s.services[0].key, 'app'); // carried over from previous
  assert.equal(s.incidents[0].id, 'i1');
  assert.match(s.note, /last known/i);
});

test('first run, nothing reachable → empty + down, never a false all-clear', () => {
  const s = buildMonitorSnapshot({ statusResult: { ok: false }, healthOk: false, previous: null, now: NOW });
  assert.equal(s.overall, 'down');
  assert.deepEqual(s.services, []);
  assert.equal(s.appReachable, false);
});

test('a live incident/maintenance overall is preserved when healthy', () => {
  const s = buildMonitorSnapshot({ statusResult: { ok: true, snapshot: { ...liveSnapshot, overall: 'degraded' } }, healthOk: true, previous: null, now: NOW });
  assert.equal(s.overall, 'degraded');
});
