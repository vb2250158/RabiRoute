import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncSkills } from './sync-agent-skills.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'project-skills.json'), 'utf8'));

test('public catalog covers every root skill and preserves localized-project catalog', () => {
  const names = new Set();
  for (const entry of catalog.agentSkills) {
    assert.ok(!names.has(entry.name), entry.name);
    names.add(entry.name);
    const source = path.resolve(root, entry.source);
    assert.ok(source.startsWith(root + path.sep));
    const text = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8');
    assert.ok(text.startsWith('---\n') || text.startsWith('---\r\n'));
    assert.equal(text.match(/^name:\s*["']?([^"'\s]+)["']?\r?$/m)?.[1], entry.name);
    assert.ok(entry.audience && entry.hosts.length);
  }
  for (const dir of fs.readdirSync(path.join(root, 'skills'))) {
    if (fs.existsSync(path.join(root, 'skills', dir, 'SKILL.md'))) assert.ok(names.has(dir), dir);
  }
  for (const localized of catalog.skills) assert.ok(names.has(localized.name));
  // A synthetic nonexistent target exercises all public relative references without writes.
  const report = syncSkills({ sourceRoot: root, targetRoot: path.join(path.dirname(root), 'skill-check-not-installed') });
  assert.equal(report.length, catalog.agentSkills.filter(entry => entry.install !== false).length);
});

test('shared skills exclude machine usernames and credential literals', () => {
  const scan = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.(?:md|yaml|yml|json)$/.test(entry.name)) {
        const text = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(text, /[A-Z]:\\Users\\[A-Za-z0-9_-]+\\/i, file);
        assert.doesNotMatch(text, /(?:qq=|"(?:group_id|user_id)"\s*:\s*)\d{6,12}/, file);
        assert.doesNotMatch(text, /(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{20,}/, file);
      }
    }
  };
  for (const entry of catalog.agentSkills) scan(path.join(root, entry.source));
});
