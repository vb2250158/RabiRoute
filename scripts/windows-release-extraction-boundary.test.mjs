import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('./Install-RabiRouteReleaseTransaction.ps1', import.meta.url)), 'utf8');
const functions = ['Assert-NoReparse', 'Expand-ReleaseArchive'].map(name => {
  const match = source.match(new RegExp(`^function ${name}\\([^\\n]*\\)[\\s\\S]*?(?=^function )`, 'm'));
  assert.ok(match, `${name} must be extracted from the actual installer`);
  return match[0];
}).join('\n');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windowsOnly = { skip: process.platform !== 'win32' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-extraction-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, 'actual-functions.ps1');
  fs.writeFileSync(helper, '\uFEFF' + functions);
  const destination = path.join(root, 'candidate');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'original');
  return { root, helper, destination, outside };
}

function run(f, commands) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference='Stop'; . ${quote(f.helper)}; ${commands}`],
  { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
}

function archive(f, name, relative, contents) {
  const input = path.join(f.root, name);
  const file = path.join(input, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  const target = path.join(f.root, `${name}.zip`);
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-acf', target, '-C', input, '.'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return target;
}

test('actual extraction rejects a preexisting junction before tar writes outside the candidate', windowsOnly, t => {
  const f = fixture(t);
  const zip = archive(f, 'input', 'linked/escape.txt', 'must stay inside');
  fs.mkdirSync(f.destination);
  fs.symlinkSync(f.outside, path.join(f.destination, 'linked'), 'junction');
  const result = run(f, `Expand-ReleaseArchive ${quote(zip)} ${quote(f.destination)}`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Candidate contains a reparse point/);
  assert.deepEqual(fs.readdirSync(f.outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(path.join(f.outside, 'sentinel.txt'), 'utf8'), 'original');
});

test('multiple actual archives merge into a normal fresh candidate', windowsOnly, t => {
  const f = fixture(t);
  const first = archive(f, 'first', 'versions/fixture/core.txt', 'core');
  const second = archive(f, 'second', 'versions/fixture/desktop.txt', 'desktop');
  const result = run(f, `Expand-ReleaseArchive ${quote(first)} ${quote(f.destination)}; ` +
    `Expand-ReleaseArchive ${quote(second)} ${quote(f.destination)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.destination, 'versions/fixture/core.txt'), 'utf8'), 'core');
  assert.equal(fs.readFileSync(path.join(f.destination, 'versions/fixture/desktop.txt'), 'utf8'), 'desktop');
  assert.deepEqual(fs.readdirSync(f.outside), ['sentinel.txt']);
});

test('fallback extraction checks newly introduced reparse points before returning success', windowsOnly, t => {
  const f = fixture(t);
  const fakeSystemRoot = path.join(f.root, 'no-tar');
  fs.mkdirSync(fakeSystemRoot);
  const result = run(f, `$env:SystemRoot=${quote(fakeSystemRoot)}; ` +
    `function Expand-Archive { param($LiteralPath,$DestinationPath,[switch]$Force) ` +
    `New-Item -ItemType Junction -Path (Join-Path $DestinationPath 'linked') -Target ${quote(f.outside)} | Out-Null }; ` +
    `Expand-ReleaseArchive 'fixture.zip' ${quote(f.destination)}`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Candidate contains a reparse point/);
  assert.deepEqual(fs.readdirSync(f.outside), ['sentinel.txt']);
});
