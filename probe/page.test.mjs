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
