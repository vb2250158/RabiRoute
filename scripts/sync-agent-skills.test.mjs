import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncSkills } from './sync-agent-skills.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-skills-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('rabi-skills-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  const targetRoot = path.join(root, 'target');
  const backupRoot = path.join(root, 'backups');
  const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const setCatalog = entries => write('source/project-skills.json', JSON.stringify({ agentSkills: entries }));
  setCatalog([{ name: 'shared', source: 'skills/shared', hosts: ['*'] }, { name: 'only-codex', source: 'skills/only-codex', hosts: ['codex'] }]);
  write('source/skills/shared/SKILL.md', '---\nname: shared\n---\n[Contract](../../docs/contract.md)\n');
  write('source/docs/contract.md', 'Public contract\n');
  write('source/skills/only-codex/SKILL.md', 'Codex only\n');
  return { sourceRoot, targetRoot, backupRoot, write, setCatalog };
}

test('host selection, complete dependency projection and repeat synchronization', t => {
  const f = fixture(t);
  const result = syncSkills({ ...f, host: 'dsh', apply: true });
  assert.deepEqual(result.skills, [{ name: 'shared', state: 'in-sync' }]);
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'only-codex')), false);
  assert.match(fs.readFileSync(path.join(f.targetRoot, 'shared/SKILL.md'), 'utf8'), /source\/docs\/contract.md/);
  assert.deepEqual(syncSkills({ ...f, host: 'dsh' }), [{ name: 'shared', state: 'in-sync' }]);
  f.write('source/skills/shared/reference.md', 'New reference\n');
  syncSkills({ ...f, host: 'dsh', apply: true });
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'shared/reference.md'), 'utf8'), 'New reference\n');
});

test('unreviewed existing files and later local edits are preserved', t => {
  const f = fixture(t);
  f.write('target/shared/SKILL.md', 'Local work\n');
  assert.throws(() => syncSkills({ ...f, apply: true }), /semantic review/);
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'shared/SKILL.md'), 'utf8'), 'Local work\n');
  syncSkills({ ...f, apply: true, adopt: true });
  f.write('target/shared/SKILL.md', 'New local work\n');
  assert.throws(() => syncSkills({ ...f, apply: true }), /semantic review/);
});

test('retired files remain recoverable from the verified snapshot', t => {
  const f = fixture(t);
  f.write('target/shared/legacy.py', 'private machine worker\n');
  const result = syncSkills({ ...f, apply: true, adopt: true });
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'shared/legacy.py')), false);
  assert.equal(fs.readFileSync(path.join(result.backup, 'shared/legacy.py'), 'utf8'), 'private machine worker\n');
});

test('write failure restores original bytes and removes partially added files', t => {
  const f = fixture(t);
  f.write('target/shared/SKILL.md', 'Original bytes\n');
  f.write('source/skills/shared/z-failure.md', 'New bytes\n');
  const original = fs.writeFileSync;
  let failed = false;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (!failed && String(file).startsWith(f.targetRoot) && String(file).endsWith('z-failure.md')) { failed = true; throw new Error('disk failure'); }
    return original(file, ...args);
  });
  assert.throws(() => syncSkills({ ...f, apply: true, adopt: true }), /restored after failure/);
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'shared/SKILL.md'), 'utf8'), 'Original bytes\n');
  assert.equal(fs.existsSync(path.join(f.targetRoot, 'shared/.rabi-skill-lock.json')), false);
});

test('catalog traversal, broken links and unsafe backup paths fail before replacement', t => {
  const f = fixture(t);
  f.setCatalog([{ name: 'escape', source: '../outside', hosts: ['*'] }]);
  assert.throws(() => syncSkills({ ...f, apply: true }), /escapes root/);
  f.setCatalog([{ name: 'shared', source: 'skills/shared', hosts: ['*'] }]);
  f.write('source/skills/shared/SKILL.md', '[Missing](missing.md)\n');
  assert.throws(() => syncSkills({ ...f, apply: true }), /Broken source reference/);
  f.write('source/skills/shared/SKILL.md', 'Safe\n');
  assert.throws(() => syncSkills({ ...f, backupRoot: path.join(f.targetRoot, 'backup'), apply: true }), /outside source and target/);
  assert.equal(fs.existsSync(f.targetRoot), false);
});

function directoryLink(t, destination, link) {
  try { fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links unavailable: ' + error.code); return false; }
    throw error;
  }
  return true;
}

for (const rootName of ['sourceRoot', 'targetRoot']) {
  test('backup links to ' + rootName + ' fail before changing content', t => {
    const f = fixture(t);
    f.write('target/shared/SKILL.md', 'Keep target\n');
    if (!directoryLink(t, f[rootName], f.backupRoot)) return;
    assert.throws(() => syncSkills({ ...f, apply: true, adopt: true }), /Linked path/);
    assert.equal(fs.readFileSync(path.join(f.targetRoot, 'shared/SKILL.md'), 'utf8'), 'Keep target\n');
    assert.equal(fs.existsSync(path.join(f.sourceRoot, 'skills/shared/.rabi-skill-lock.json')), false);
  });
}

test('a missing target under a linked ancestor fails without creating directories', t => {
  const f = fixture(t);
  const alias = path.join(path.dirname(f.targetRoot), 'alias');
  if (!directoryLink(t, f.sourceRoot, alias)) return;
  assert.throws(() => syncSkills({ ...f, targetRoot: path.join(alias, 'missing/skills'), apply: true }), /Linked path/);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, 'missing')), false);
  assert.equal(fs.existsSync(f.backupRoot), false);
});

test('source root aliases and dangling backup links are rejected during dry run', t => {
  const f = fixture(t);
  const alias = path.join(path.dirname(f.sourceRoot), 'alias');
  if (!directoryLink(t, f.sourceRoot, alias)) return;
  assert.throws(() => syncSkills({ ...f, sourceRoot: alias }), /Linked path/);
  const missing = path.join(path.dirname(f.sourceRoot), 'missing');
  if (!directoryLink(t, missing, f.backupRoot)) return;
  assert.throws(() => syncSkills(f), /Linked path/);
  assert.equal(fs.existsSync(f.targetRoot), false);
});

test('backup cannot contain either root and adjacent prefixes remain disjoint', t => {
  const f = fixture(t);
  assert.throws(() => syncSkills({ ...f, backupRoot: path.dirname(f.sourceRoot), apply: true }), /outside source and target/);
  assert.equal(fs.existsSync(f.targetRoot), false);
  const adjacent = f.sourceRoot + '-projection';
  assert.ok(syncSkills({ ...f, targetRoot: adjacent, apply: true }).skills.length);
  assert.ok(fs.existsSync(path.join(adjacent, 'shared/SKILL.md')));
});

test('Windows case and alternate separators preserve identity without accepting overlap', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  assert.throws(() => syncSkills({ ...f, targetRoot: f.sourceRoot.toUpperCase().replaceAll('\\', '/'), apply: true }), /disjoint/);
  const result = syncSkills({ ...f, sourceRoot: f.sourceRoot.toUpperCase().replaceAll('\\', '/'), targetRoot: f.targetRoot.toUpperCase(), apply: true });
  assert.ok(result.skills.length);
});

test('a file occupying the backup root fails before creating the target', t => {
  const f = fixture(t);
  f.write('backups', 'Keep file\n');
  assert.throws(() => syncSkills({ ...f, apply: true }), /Root is not a directory/);
  assert.equal(fs.existsSync(f.targetRoot), false);
  assert.equal(fs.readFileSync(f.backupRoot, 'utf8'), 'Keep file\n');
});

test('linked lock and linked backup ancestor do not bypass safety checks', t => {
  const f = fixture(t);
  f.write('target/shared/SKILL.md', 'Unchanged\n');
  const lock = path.join(f.targetRoot, 'shared/.rabi-skill-lock.json');
  if (!directoryLink(t, f.sourceRoot, lock)) return;
  assert.throws(() => syncSkills({ ...f, apply: true, adopt: true }), /Linked content/);
  fs.unlinkSync(lock);
  const alias = path.join(path.dirname(f.backupRoot), 'backup-alias');
  if (!directoryLink(t, f.sourceRoot, alias)) return;
  assert.throws(() => syncSkills({ ...f, backupRoot: path.join(alias, 'not-created'), apply: true, adopt: true }), /Linked path/);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, 'not-created')), false);
  assert.equal(fs.readFileSync(path.join(f.targetRoot, 'shared/SKILL.md'), 'utf8'), 'Unchanged\n');
});

function targetFileHashes(root, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, targetFileHashes(file, relative + '/'));
    else result[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return Object.fromEntries(Object.entries(result).sort());
}

for (const [direction, empty] of [['file-to-directory', false], ['directory-to-file', false], ['file-to-directory', true], ['directory-to-file', true]]) {
  test('file-directory shape conflict ' + direction + (empty ? ' with empty directory' : '') + ' rejects before changing any target hash', t => {
    const f = fixture(t);
    f.write('target/shared/SKILL.md', 'Original entry, not the new source projection.\n');
    f.write('target/shared/.rabi-skill-lock.json', '{}\n');
    f.write('target/unselected/keep.txt', 'Keep unrelated target bytes.\n');
    if (direction === 'file-to-directory') {
      f.write('target/shared/refs', 'Original regular file.\n');
      if (empty) fs.mkdirSync(path.join(f.sourceRoot, 'skills/shared/refs'));
      else f.write('source/skills/shared/refs/guide.md', 'Desired nested body.\n');
    } else {
      if (empty) fs.mkdirSync(path.join(f.targetRoot, 'shared/refs'));
      else f.write('target/shared/refs/guide.md', 'Original nested body.\n');
      f.write('source/skills/shared/refs', 'Desired regular file.\n');
    }
    // Reproduce the harmful order regardless of filesystem enumeration order:
    // the valid entry would be written before the conflicting refs path.
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (directory, ...args) => {
      const entries = readdir(directory, ...args);
      if (String(directory) === path.join(f.sourceRoot, 'skills/shared')) return entries.sort((a, b) => Number(b.name === 'SKILL.md') - Number(a.name === 'SKILL.md'));
      return entries;
    });
    const before = targetFileHashes(f.targetRoot);
    let failure;
    try { syncSkills({ ...f, apply: true, adopt: true }); }
    catch (error) { failure = error; }
    assert.ok(failure, 'Shape changes must be rejected, not migrated implicitly.');
    assert.deepEqual(targetFileHashes(f.targetRoot), before);
    assert.match(failure.message, /File\/directory shape conflict/);
    if (empty) {
      const directory = direction === 'file-to-directory' ? path.join(f.sourceRoot, 'skills/shared/refs') : path.join(f.targetRoot, 'shared/refs');
      assert.equal(fs.statSync(directory).isDirectory(), true);
      assert.deepEqual(fs.readdirSync(directory), [], 'The existing empty directory must not be removed or populated.');
    }
    assert.equal(fs.existsSync(f.backupRoot), false, 'Planning must reject before creating backups or writing targets.');
  });
}
