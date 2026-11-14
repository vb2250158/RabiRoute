import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, '.agents/aiui-dev-source.json'), 'utf8').replace(/^\uFEFF/, ''));
assert.equal(manifest.repository, 'https://github.com/yodaos-project/AIUI');
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
assert.equal(manifest.path, 'skills/aiui-dev');
assert.ok(manifest.files.length > 0);

function filesUnder(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false, 'Skill content must not escape through symbolic links');
    const name = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(root, name) : [name];
  }).sort();
}

function verify(root, label) {
  const expected = manifest.files.map(file => file.path).sort();
  assert.deepEqual(filesUnder(root), expected, `${label}: missing or obsolete skill files`);
  for (const file of manifest.files) {
    const relative = path.relative(root, path.resolve(root, file.path));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const bytes = fs.readFileSync(path.join(root, relative));
    const blobHash = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(blobHash, file.gitBlobSha1, `${label}: official content differs at ${file.path}`);
  }
  console.log(`${label}: ${expected.length} official files verified at ${manifest.commit}`);
}

verify(path.join(projectRoot, '.agents/skills/aiui-dev'), 'Project aiui-dev');
const installed = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills/aiui-dev');
if (fs.existsSync(installed)) verify(installed, 'Installed aiui-dev');
else console.log('Installed aiui-dev absent; project copy remains authoritative.');
