import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const windowsOnly = { skip: process.platform !== 'win32' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-build-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const local = path.join(root, 'local');
  const temp = path.join(root, 'temp');
  for (const directory of [path.join(repo, 'scripts', 'lib'), local, temp]) fs.mkdirSync(directory, { recursive: true });
  for (const name of ['build-desktop-runtime.ps1', 'build-windows-host.ps1', 'build-windows-release.ps1', 'lib/build-output-boundary.ps1']) {
    fs.copyFileSync(path.join(scripts, name), path.join(repo, 'scripts', name));
  }
  fs.writeFileSync(path.join(repo, 'package.json'), '{"version":"0.0.0"}');
  const marker = path.join(repo, 'preserve.txt');
  fs.writeFileSync(marker, 'original');
  return { root, repo, local, temp, marker };
}

function run(f, command) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['localappdata', 'temp', 'tmp', 'psmodulepath'].includes(key.toLowerCase())));
  Object.assign(env, { LOCALAPPDATA: f.local, TEMP: f.temp, TMP: f.temp });
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$ErrorActionPreference='Stop'; ${command}`], { encoding: 'utf8', windowsHide: true, timeout: 15000, env });
}

function validate(f, output, args = '') {
  return run(f, `. ${quote(path.join(f.repo, 'scripts/lib/build-output-boundary.ps1'))}; ` +
    `Assert-BuildOutputBoundary -OutputRoot ${quote(output)} -RepositoryRoot ${quote(f.repo)} ${args}`);
}

function rejected(f, result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Refusing a build output/);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), 'original');
}

for (const name of ['build-desktop-runtime.ps1', 'build-windows-host.ps1', 'build-windows-release.ps1']) {
  test(`${name} rejects repository and installation outputs at the real entry`, windowsOnly, t => {
    const f = fixture(t);
    for (const output of [f.repo, f.root, path.join(f.repo, 'desktop'), path.join(f.local, 'Programs/RabiRoute/versions/candidate')]) {
      const result = run(f, `& ${quote(path.join(f.repo, 'scripts', name))} -OutputRoot ${quote(output)}`);
      assert.match(result.stderr, /Refusing a build output/, `Output ${output}: ${result.stdout}\n${result.stderr}`);
      rejected(f, result);
    }
  });
}

test('normal TEMP, LOCALAPPDATA and private repository candidates remain valid', windowsOnly, t => {
  const f = fixture(t);
  for (const output of [path.join(f.temp, 'desktop'), path.join(f.local, 'RabiRoute/build/host'), path.join(f.repo, '.tmp/candidate')]) {
    const result = validate(f, output);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(output), false, 'validation has no output writes');
  }
});

test('release preflight rejects sibling runtime overlap before any build', windowsOnly, t => {
  const f = fixture(t);
  const runtime = path.join(f.root, 'runtime');
  rejected(f, run(f, `& ${quote(path.join(f.repo, 'scripts/build-windows-release.ps1'))} ` +
    `-OutputRoot ${quote(path.join(f.root, 'release'))} -DesktopRuntimeRoot ${quote(runtime)} ` +
    `-HostRuntimeRoot ${quote(path.join(runtime, 'host'))}`));
  assert.equal(fs.existsSync(runtime), false);
});

test('owned release leaves preserve independent nested runtimes and reject payload overlap', windowsOnly, t => {
  const f = fixture(t);
  const output = path.join(f.root, 'release');
  const safe = validate(f, output, `-OwnedLeaves @('version-payload','distribution') -InputPaths @(${quote(path.join(output, 'runtime-host'))})`);
  assert.equal(safe.status, 0, safe.stderr);
  rejected(f, validate(f, output, `-OwnedLeaves @('version-payload','distribution') -InputPaths @(${quote(path.join(output, 'version-payload/runtime'))})`));
});

test('reparse ancestors and descendants are rejected without following links', windowsOnly, t => {
  const f = fixture(t);
  const target = path.join(f.root, 'target');
  const output = path.join(f.root, 'output');
  fs.mkdirSync(target); fs.mkdirSync(output);
  const link = path.join(output, 'linked');
  fs.symlinkSync(target, link, 'junction');
  t.after(() => { if (fs.existsSync(link)) fs.unlinkSync(link); });
  rejected(f, validate(f, path.join(link, 'nested')));
  rejected(f, validate(f, output));
  assert.equal(fs.existsSync(target), true);
});

test('custom installed root markers and explicit input ancestors are protected', windowsOnly, t => {
  const f = fixture(t);
  const install = path.join(f.root, 'custom-install');
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, 'current.json'), '{}');
  fs.writeFileSync(path.join(install, 'RabiRouteHost.exe'), 'fixture');
  rejected(f, validate(f, path.join(install, 'build')));
  const output = path.join(f.root, 'nested-output');
  const nestedInstall = path.join(output, 'installed');
  fs.mkdirSync(nestedInstall, { recursive: true });
  fs.writeFileSync(path.join(nestedInstall, 'current.json'), '{}');
  fs.writeFileSync(path.join(nestedInstall, 'RabiRouteHost.exe'), 'fixture');
  rejected(f, validate(f, output));
  rejected(f, validate(f, path.join(f.root, 'output'), `-InputPaths @(${quote(path.join(f.root, 'output/input'))})`));
});
