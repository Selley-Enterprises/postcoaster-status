import assert from 'node:assert/strict';
import test from 'node:test';

import { runProbe } from './index.mjs';

const OWNER = 'Selley-Enterprises';
const REPO = 'postcoaster-status';

const liveSnapshot = {
  overall: 'operational',
  services: [{ key: 'app', label: 'PostCoaster app', state: 'operational', uptime90d: 100 }],
  incidents: [],
};

const storedSnapshot = (polledAt) => ({
  polledAt,
  appReachable: true,
  source: 'live',
  overall: 'operational',
  note: null,
  services: liveSnapshot.services,
  incidents: [],
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function encodeContent(obj) {
  return btoa(`${JSON.stringify(obj, null, 2)}\n`);
}

function createFakeGithub({ dataExists, mainHasSnapshot, snapshotAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  const oldPolledAt = new Date(Date.now() - snapshotAgeMs).toISOString();
  const files = {
    main: {},
    data: dataExists ? {} : null,
  };
  if (mainHasSnapshot) files.main['snapshot.json'] = { sha: 'sha-main', content: storedSnapshot(oldPolledAt) };
  if (dataExists && mainHasSnapshot) {
    files.data['snapshot.json'] = { sha: 'sha-data', content: storedSnapshot(oldPolledAt) };
  }

  const calls = [];

  async function fakeFetch(url, opts = {}) {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ method, url: u, body: opts.body || null });

    if (u.endsWith('/api/status')) return jsonResponse({ ok: true, ...liveSnapshot });
    if (u.endsWith('/api/healthz')) return new Response('ok', { status: 200 });

    const refMatch = /\/git\/ref\/heads\/([^/?]+)$/.exec(u);
    if (refMatch && method === 'GET') {
      const branch = decodeURIComponent(refMatch[1]);
      if (files[branch] == null) return new Response('Not Found', { status: 404 });
      return jsonResponse({ object: { sha: `commit-${branch}` } });
    }

    if (u.endsWith('/git/refs') && method === 'POST') {
      const payload = JSON.parse(opts.body);
      const name = payload.ref.replace(/^refs\/heads\//, '');
      files[name] = structuredClone(files.main);
      return jsonResponse({ ref: payload.ref, object: { sha: payload.sha } }, 201);
    }

    const getContents = /\/contents\/snapshot\.json\?ref=([^&]+)/.exec(u);
    if (getContents && method === 'GET') {
      const branch = decodeURIComponent(getContents[1]);
      if (files[branch] == null) return new Response('Not Found', { status: 404 });
      const file = files[branch]['snapshot.json'];
      if (!file) return new Response('Not Found', { status: 404 });
      return jsonResponse({ sha: file.sha, content: encodeContent(file.content) });
    }

    if (u.includes('/contents/snapshot.json') && method === 'PUT') {
      const payload = JSON.parse(opts.body);
      const branch = payload.branch;
      if (files[branch] == null) return jsonResponse({ message: 'Not Found' }, 404);
      const existing = files[branch]['snapshot.json'];
      if (existing && !payload.sha) {
        return jsonResponse({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, 422);
      }
      if (existing && payload.sha !== existing.sha) {
        return jsonResponse({ message: 'sha mismatch' }, 409);
      }
      files[branch]['snapshot.json'] = { sha: 'sha-new', content: JSON.parse(atob(payload.content)) };
      return jsonResponse({ content: { sha: 'sha-new' } });
    }

    return new Response(`unhandled ${method} ${u}`, { status: 500 });
  }

  return { fetch: fakeFetch, files, calls };
}

const env = {
  GITHUB_TOKEN: 'test-token',
  GITHUB_OWNER: OWNER,
  GITHUB_REPO: REPO,
  GITHUB_BRANCH: 'data',
  POSTCOASTER_APP_URL: 'https://app.postcoaster.com',
};

test('first write to a missing data branch that inherited snapshot.json from main supplies sha', async () => {
  const fake = createFakeGithub({ dataExists: false, mainHasSnapshot: true });
  const prev = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const result = await runProbe(env);
    assert.equal(result.committed, true);
    const put = fake.calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'expected a Contents PUT');
    const payload = JSON.parse(put.body);
    assert.equal(payload.sha, 'sha-main');
    assert.equal(payload.branch, 'data');
  } finally {
    globalThis.fetch = prev;
  }
});

test('first write when main has no snapshot.json creates the file without a sha', async () => {
  const fake = createFakeGithub({ dataExists: false, mainHasSnapshot: false });
  const prev = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const result = await runProbe(env);
    assert.equal(result.committed, true);
    assert.equal(result.reason, 'no-previous-snapshot');
    const put = fake.calls.find((c) => c.method === 'PUT');
    assert.ok(put);
    const payload = JSON.parse(put.body);
    assert.equal(payload.sha, undefined);
  } finally {
    globalThis.fetch = prev;
  }
});

test('dry-run does not create the data branch', async () => {
  const fake = createFakeGithub({ dataExists: false, mainHasSnapshot: true });
  const prev = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const result = await runProbe(env, { dryRun: true });
    assert.equal(result.committed, false);
    assert.equal(result.dryRun, true);
    assert.equal(fake.files.data, null);
    assert.equal(fake.calls.some((c) => c.method === 'POST' && c.url.endsWith('/git/refs')), false);
    assert.equal(fake.calls.some((c) => c.method === 'PUT'), false);
  } finally {
    globalThis.fetch = prev;
  }
});
