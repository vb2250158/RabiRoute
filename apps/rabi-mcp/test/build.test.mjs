import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertBuildDirectory, buildArtifact } from '../scripts/build.mjs';

test('build requires an explicit absolute destination', async () => {
  await assert.rejects(buildArtifact(), /explicit/);
  await assert.rejects(buildArtifact('relative'), /explicit/);
  await assert.rejects(assertBuildDirectory('relative'), /absolute/);
});
test('an accessible network directory is not rejected by storage type', async () => {
  const network = process.platform === 'win32' ? '\\\\server\\share' : '//server/share';
  assert.equal(await assertBuildDirectory(network, { realpath: async value => value, stat: async () => ({ isDirectory: () => true }) }), network);
});
test('existing output is retained unchanged', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-mcp-output-test-'));
  try {
    await fs.writeFile(path.join(directory, 'keep.txt'), 'retained');
    await assert.rejects(buildArtifact(directory), /already exists/);
    assert.equal(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'), 'retained');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
