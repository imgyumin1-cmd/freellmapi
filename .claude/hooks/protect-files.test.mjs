import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { blockReason } from './protect-files.mjs';

const root = '/repo';
const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'protect-files.mjs');
const tracked = () => true;
const untracked = () => false;

test('blocks lockfiles anywhere in the repo', () => {
  assert.match(blockReason('/repo/package-lock.json', { root, tracked }), /npm/);
  assert.match(blockReason('desktop/package-lock.json', { root, tracked }), /npm/);
});

test('blocks .env files but not .env.example', () => {
  assert.match(blockReason('/repo/.env', { root, tracked }), /secrets/);
  assert.match(blockReason('/repo/.env.local', { root, tracked }), /secrets/);
  assert.equal(blockReason('/repo/.env.example', { root, tracked }), null);
});

test('blocks committed migrations and allows new ones', () => {
  const file = '/repo/server/src/db/migrations/20261111_000001_model_monthly_usage.ts';
  assert.match(blockReason(file, { root, tracked }), /db:migration:create/);
  assert.equal(blockReason(file, { root, tracked: untracked }), null);
});

test('allows ordinary source files and paths outside the repo', () => {
  assert.equal(blockReason('/repo/server/src/providers/index.ts', { root, tracked }), null);
  assert.equal(blockReason('/elsewhere/.env', { root, tracked }), null);
  assert.equal(blockReason(undefined, { root, tracked }), null);
});

test('exits 2 with a reason when run as a hook', () => {
  const payload = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'package-lock.json' } });
  const result = spawnSync(process.execPath, [hookPath], { input: payload, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /protect-files/);
});

test('exits 0 for allowed files and for malformed input', () => {
  const ok = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_input: { file_path: 'README.md' } }),
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  const garbage = spawnSync(process.execPath, [hookPath], { input: 'not json', encoding: 'utf8' });
  assert.equal(garbage.status, 0);
});
