import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deviceEnvironment } from '../src/windows-job.mjs';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function eventually(read, predicate, label) {
  for (let n = 0; n < 150; n++) { const value = await read(); if (predicate(value)) return value; await delay(20); }
  throw Error(label);
}
async function launch(directory, name, suspended = false) {
  const record = join(directory, name + '.json');
  const parent = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/job-parent.mjs', import.meta.url)), record, suspended ? 'suspended' : 'running'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: deviceEnvironment() });
  let line = '', stderr = ''; parent.stdout.on('data', data => { line += data; }); parent.stderr.on('data', data => { stderr += data; });
  const child = await eventually(() => line, x => x.includes('\n') || parent.exitCode !== null, 'Parent startup timeout');
  assert.equal(parent.exitCode, null, stderr);
  const pid = JSON.parse(child.trim()).pid;
  const pids = suspended ? { child: pid } : await eventually(async () => {
    try { return JSON.parse(await readFile(record, 'utf8')); } catch { return null; }
  }, Boolean, 'Child startup timeout');
  return { parent, pids };
}
test('real Windows Job owns children across normal exit, force exit and suspended startup; other owner survives', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-job-test-'));
  const parents = [];
  try {
    const other = await launch(directory, 'other'); parents.push(other.parent);
    for (const [mode, suspended] of [['dispose', false], ['exit', false], ['kill', false], ['kill', true]]) {
      const item = await launch(directory, mode + suspended, suspended); parents.push(item.parent);
      const exited = once(item.parent, 'exit');
      if (mode === 'kill') item.parent.kill(); else item.parent.stdin.write(mode + '\n');
      await exited;
      for (const pid of Object.values(item.pids)) await eventually(() => alive(pid), value => !value, 'Owned descendant leaked: ' + pid);
      assert.equal(alive(other.pids.child), true); assert.equal(alive(other.pids.grandchild), true);
    }
    const exited = once(other.parent, 'exit'); other.parent.stdin.write('dispose\n'); await exited;
    for (const pid of Object.values(other.pids)) await eventually(() => alive(pid), value => !value, 'Other owner cleanup failed');
  } finally {
    for (const parent of parents) if (parent.exitCode === null && parent.signalCode === null) parent.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
