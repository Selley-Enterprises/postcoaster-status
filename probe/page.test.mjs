import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('status navigation links to the canonical customer changelog', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<a href="https:\/\/www\.postcoaster\.com\/changelog">Product updates<\/a>/);
});

test('production page loads snapshot.json from the data branch, not Pages-hosted main', async () => {
  const js = await readFile(path.join(ROOT, 'render.js'), 'utf8');
  assert.match(js, /SNAPSHOT_BRANCH = 'data'/);
  assert.match(js, /raw\.githubusercontent\.com\/\$\{SNAPSHOT_REPO\}\/\$\{SNAPSHOT_BRANCH\}\/snapshot\.json/);
  assert.match(js, /\.\/snapshot\.json/);
});

test('localhost snapshot path includes IPv6 loopback', async () => {
  const js = await readFile(path.join(ROOT, 'render.js'), 'utf8');
  assert.match(js, /host === '\[::1\]'/);
  assert.match(js, /host === '::1'/);
});

test('emergency probe runs dispatch-ref code and writes only to data', async () => {
  const yml = await readFile(path.join(ROOT, '.github/workflows/probe.yml'), 'utf8');
  const checkouts = yml.match(/uses: actions\/checkout@v4/g) || [];
  assert.equal(checkouts.length, 2);
  assert.match(yml, /path: \.data/);
  assert.match(yml, /ref: data/);
  assert.match(yml, /cp snapshot\.json \.data\/snapshot\.json/);
  assert.match(yml, /git add snapshot\.json[\s\S]*git diff --cached --quiet -- snapshot\.json/);
  assert.doesNotMatch(yml, /mkdir -p \.data/);
});
