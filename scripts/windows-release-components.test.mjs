import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const fixture = fileURLToPath(new URL('./windows-release-components.fixture.ps1', import.meta.url));
test('trusted component mapping rejects tampering while optional omissions and old portable remain valid', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', fixture], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout), accepted = Object.fromEntries(rows.map(row => [row.name, row.accepted]));
  assert.equal(accepted['full-old-portable'], true);
  assert.equal(accepted['legitimate-optional-omitted'], true);
  for (const name of ['tampered-prefix-required-plugin-missing', 'tampered-prefix-present-hash-mismatch', 'unknown-selected-component',
    'missing-required-component-definition', 'required-component-not-selected', 'unselected-existing-file-bad-hash', 'component-release-mismatch']) assert.equal(accepted[name], false, name);
});

test('splitter archives use the same component rules as the install owner', async t => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-components-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'distribution'), output = path.join(root, 'output'), id = '1.2.3-fixture';
  const entries = ['RabiRouteHost.exe', 'current.json', `versions/${id}/release-manifest.json`, `versions/${id}/dist/manager.js`,
    `versions/${id}/desktop-runtime/main.py`, `versions/${id}/node_modules/@openai/codex/file`, `versions/${id}/apps/rabi-agent/file`];
  for (const relative of entries) { const file = path.join(dist, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, relative.endsWith('release-manifest.json') ? JSON.stringify({ packageVersion: '1.2.3', payloadSha256: 'example' }) : 'fixture'); }
  const script = fileURLToPath(new URL('./split-windows-release-components.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--distribution', dist, '--output', output], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const trusted = JSON.parse(fs.readFileSync(new URL('./windows-release-components.json', import.meta.url), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(dist, 'components.json'), 'utf8'));
  assert.deepEqual(metadata.components, trusted.components.map(({ id, required, manifestPrefixes }) => ({ id, required, manifestPrefixes })));
  const built = JSON.parse(fs.readFileSync(path.join(output, 'components.json'), 'utf8'));
  assert.deepEqual(built.components.map(row => row.id), trusted.components.map(row => row.id));
  assert.equal(built.components.every(row => row.fileCount > 0 && /^[a-f0-9]{64}$/.test(row.sha256)), true);
});
