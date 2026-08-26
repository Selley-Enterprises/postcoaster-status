import assert from 'node:assert/strict';
import test from 'node:test';

import { HEARTBEAT_MS, isMeaningfullyDifferent, shouldCommitSnapshot, snapshotFingerprint } from './snapshot.mjs';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

const snapshotAt = (polledAt, overrides = {}) => ({
  polledAt,
  appReachable: true,
  source: 'live',
  overall: 'operational',
  note: null,
  services: [{ key: 'app', label: 'PostCoaster app', state: 'operational', uptime90d: 99.98 }],
  incidents: [],
  ...overrides,
});

test('only polledAt differs → NOT meaningfully different', () => {
  const previous = snapshotAt('2026-07-26T11:55:00.000Z');
  const next = snapshotAt('2026-07-26T12:00:00.000Z');
  assert.equal(isMeaningfullyDifferent(previous, next), false);
  assert.equal(snapshotFingerprint(previous), snapshotFingerprint(next));
});

test('only uptime90d differs → NOT meaningfully different', () => {
  const previous = snapshotAt('2026-07-26T11:55:00.000Z');
  const next = snapshotAt('2026-07-26T12:00:00.000Z', {
    services: [{ key: 'app', label: 'PostCoaster app', state: 'operational', uptime90d: 99.97 }],
  });
  assert.equal(isMeaningfullyDifferent(previous, next), false);
  const decision = shouldCommitSnapshot({ previous, next, now: NOW });
  assert.equal(decision.commit, false);
  assert.equal(decision.reason, 'unchanged');
});

test('key order does not register as a change', () => {
  const previous = { services: [], incidents: [], note: null, overall: 'operational', source: 'live', appReachable: true, polledAt: '2026-07-26T11:55:00.000Z' };
  const next = snapshotAt('2026-07-26T12:00:00.000Z', { services: [] });
  assert.equal(isMeaningfullyDifferent(previous, next), false);
});

test('a changed overall IS meaningfully different', () => {
  const previous = snapshotAt('2026-07-26T11:55:00.000Z');
  const next = snapshotAt('2026-07-26T12:00:00.000Z', { overall: 'degraded' });
  assert.equal(isMeaningfullyDifferent(previous, next), true);
});

test('a changed service state IS meaningfully different', () => {
  const previous = snapshotAt('2026-07-26T11:55:00.000Z');
  const next = snapshotAt('2026-07-26T12:00:00.000Z', {
    services: [{ key: 'app', label: 'PostCoaster app', state: 'down', uptime90d: 99.98 }],
  });
  assert.equal(isMeaningfullyDifferent(previous, next), true);
});

test('appReachable / source / note / incidents are all compared', () => {
  const previous = snapshotAt('2026-07-26T11:55:00.000Z');
  for (const overrides of [{ appReachable: false }, { source: 'stale' }, { note: 'heads up' }, { incidents: [{ id: 'i1' }] }]) {
    assert.equal(isMeaningfullyDifferent(previous, snapshotAt('2026-07-26T12:00:00.000Z', overrides)), true);
  }
});

test('unchanged and within the heartbeat window → skip the commit', () => {
  const previous = snapshotAt(new Date(NOW - 5 * 60 * 1000).toISOString());
  const decision = shouldCommitSnapshot({ previous, next: snapshotAt(new Date(NOW).toISOString()), now: NOW });
  assert.equal(decision.commit, false);
  assert.equal(decision.reason, 'unchanged');
});

test('unchanged but heartbeat threshold exceeded → commit anyway', () => {
  const previous = snapshotAt(new Date(NOW - HEARTBEAT_MS - 1000).toISOString());
  const decision = shouldCommitSnapshot({ previous, next: snapshotAt(new Date(NOW).toISOString()), now: NOW });
  assert.equal(decision.commit, true);
  assert.equal(decision.reason, 'heartbeat');
});

test('meaningful change inside the heartbeat window → commit immediately', () => {
  const previous = snapshotAt(new Date(NOW - 60 * 1000).toISOString());
  const next = snapshotAt(new Date(NOW).toISOString(), { overall: 'down', appReachable: false });
  const decision = shouldCommitSnapshot({ previous, next, now: NOW });
  assert.equal(decision.commit, true);
  assert.equal(decision.reason, 'changed');
});

test('no previous snapshot → always commit', () => {
  const decision = shouldCommitSnapshot({ previous: null, next: snapshotAt(new Date(NOW).toISOString()), now: NOW });
  assert.equal(decision.commit, true);
  assert.equal(decision.reason, 'no-previous-snapshot');
});

test('unreadable previous polledAt → commit rather than stall', () => {
  const previous = snapshotAt('not-a-date');
  const decision = shouldCommitSnapshot({ previous, next: snapshotAt(new Date(NOW).toISOString()), now: NOW });
  assert.equal(decision.commit, true);
  assert.equal(decision.reason, 'previous-polledAt-unreadable');
});

test('HEARTBEAT_MS is one hour → ~24 commits/day worst case at a 5-minute poll', () => {
  assert.equal(HEARTBEAT_MS, 60 * 60 * 1000);
});
