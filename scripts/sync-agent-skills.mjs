import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = '.rabi-skill-lock.json';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

/** Native relative paths handle Windows casing and separators without prefix collisions. */
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function disjoint(left, right) {
  return !inside(left, right) && !inside(right, left);
}

/** Check every existing ancestor, including dangling links, before any filesystem mutation. */
function realPathWithoutLinks(value) {
  const full = path.resolve(value);
  const missing = [];
  let cursor = full;
  let resolved;
  while (true) {
    let info;
    try { info = fs.lstatSync(cursor); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      if (info.isSymbolicLink()) throw new Error('Linked path is not allowed: ' + cursor);
      if (cursor !== full && !info.isDirectory()) throw new Error('Parent is not a directory: ' + cursor);
      if (resolved === undefined) resolved = path.resolve(fs.realpathSync(cursor), ...missing);
    } else {
      missing.unshift(path.basename(cursor));
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (resolved === undefined) throw new Error('No existing path ancestor: ' + full);
  if (path.relative(full, resolved) !== '') throw new Error('Path resolves through an alias: ' + full);
  return resolved;
}

/** Roots cannot be occupied by files, even when planning without writes. */
function directoryRoot(value) {
  const root = realPathWithoutLinks(value);
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) throw new Error('Root is not a directory: ' + root);
  return root;
}

/** Resolve a catalog path without allowing it to escape its source tree. */
function within(root, relative) {
  const full = path.resolve(root, relative);
  if (path.relative(root, full) === '' || !inside(root, full)) throw new Error('Path escapes root: ' + relative);
  return realPathWithoutLinks(full);
}

/** Read files and collect actual directory shapes, including empty directories. */
function tree(root, prefix = '', directories = new Set()) {
  realPathWithoutLinks(root);
  if (!fs.existsSync(root)) return {};
  const result = {};
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Linked content must not be overwritten: ' + path.join(root, entry.name));
    if (entry.name === LOCK) continue;
    const name = prefix + entry.name;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      directories.add(name);
      Object.assign(result, tree(file, name + '/', directories));
    } else if (entry.isFile()) result[name] = fs.readFileSync(file);
  }
  return result;
}

const hashes = files => Object.fromEntries(Object.entries(files).map(([name, value]) => [name, digest(value)]));
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Shape migrations need a separate reviewed operation; reject before any writes. */
function assertCompatibleFileShapes(current, desired, currentDirectories, desiredDirectories) {
  const key = name => process.platform === 'win32' ? path.normalize(name).toLowerCase() : path.normalize(name);
  for (const [files, directories] of [[current, desiredDirectories], [desired, currentDirectories]]) {
    const directoryKeys = new Set([...directories].map(key));
    for (const name of Object.keys(files)) {
      if (directoryKeys.has(key(name))) throw new Error('File/directory shape conflict: ' + name);
    }
  }
}

/** Project repository-relative Markdown links to the verified local source checkout. */
function project(files, source) {
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => {
    if (!name.endsWith('.md')) return [name, bytes];
    let text = bytes.toString('utf8').replace(/\]\(([^\s)]+)\)/g, (whole, link) => {
      if (/^(?:[a-z]+:|#|\/|<)/i.test(link)) return whole;
      const [relative, anchor] = link.split('#');
      const target = path.resolve(source, path.dirname(name), relative);
      if (!fs.existsSync(target)) throw new Error('Broken source reference: ' + name + ' -> ' + link);
      if (target.startsWith(source + path.sep)) return whole;
      return '](<' + target.replaceAll('\\', '/') + (anchor ? '#' + anchor : '') + '>)';
    });
    if (name === 'SKILL.md') {
      const provenance = '\n本机来源：[权威技能](<' + path.join(source, 'SKILL.md').replaceAll('\\', '/') + '>)。仓库相对命令在源仓库执行；插件相对命令按源技能所在插件目录解析。此行为安装元数据，不回流公开源文件。\n';
      text = text.replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/, '$1' + provenance);
    }
    return [name, Buffer.from(text)];
  }));
}

/** Plan or apply a versioned skill projection; caller owns the explicit target directory. */
export function syncSkills({ sourceRoot = ROOT, catalog = 'project-skills.json', targetRoot, backupRoot, host = 'all', apply = false, adopt = false }) {
  if (!targetRoot) throw new Error('targetRoot is required.');
  const source = directoryRoot(sourceRoot);
  const target = directoryRoot(targetRoot);
  if (!disjoint(source, target)) throw new Error('Source and target roots must be disjoint.');
  const backup = backupRoot ? directoryRoot(backupRoot) : null;
  if (backup && (!disjoint(backup, source) || !disjoint(backup, target))) throw new Error('Backups must be outside source and target roots, and cannot contain them.');
  const data = JSON.parse(fs.readFileSync(within(source, catalog), 'utf8'));
  if (!Array.isArray(data.agentSkills)) throw new Error('Catalog has no agentSkills.');
  if (!['all', 'codex', 'dsh', 'workbuddy'].includes(host)) throw new Error('Unsupported host selector.');
  const selected = data.agentSkills.filter(entry => entry.install !== false && (host === 'all' || entry.hosts.includes('*') || entry.hosts.includes(host)));
  const names = new Set();
  const plans = selected.map(entry => {
    if (!/^[a-z0-9-]+$/.test(entry.name) || names.has(entry.name)) throw new Error('Invalid or duplicate skill name.');
    names.add(entry.name);
    const sourceDir = within(source, entry.source);
    if (!fs.statSync(sourceDir).isDirectory()) throw new Error('Source skill must be a real directory.');
    const destination = within(target, entry.name);
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error('Target skill is a link; update its source instead.');
    const desiredDirectories = new Set();
    const raw = tree(sourceDir, '', desiredDirectories);
    if (!raw['SKILL.md']) throw new Error('Missing SKILL.md: ' + entry.name);
    const desired = project(raw, sourceDir);
    const currentDirectories = new Set();
    const current = tree(destination, '', currentDirectories);
    assertCompatibleFileShapes(current, desired, currentDirectories, desiredDirectories);
    const lockPath = path.join(destination, LOCK);
    const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null;
    const changed = !same(hashes(current), hashes(desired));
    if (changed && Object.keys(current).length && !adopt && (!lock || !same(hashes(current), lock.installedHashes))) throw new Error('Local edits require semantic review before --adopt: ' + entry.name);
    return { entry, sourceDir, destination, raw, desired, current, lock, changed };
  });
  if (!apply) return plans.map(p => ({ name: p.entry.name, state: p.changed ? 'changed' : 'in-sync' }));
  if (!backup) throw new Error('An external backupRoot is required for --apply.');
  realPathWithoutLinks(source);
  realPathWithoutLinks(target);
  realPathWithoutLinks(backup);
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  const batch = fs.mkdtempSync(path.join(backup, 'skills-'));
  // Snapshot the entire selected projection before the first write, including its prior lock.
  for (const p of plans) {
    if (fs.existsSync(p.destination)) {
      const saved = within(batch, p.entry.name);
      realPathWithoutLinks(p.destination);
      tree(p.destination);
      fs.cpSync(p.destination, saved, { recursive: true });
      if (!same(hashes(tree(saved)), hashes(p.current))) throw new Error('Backup mismatch: ' + p.entry.name);
    }
  }
  for (const p of plans) {
    if (!same(hashes(tree(p.destination)), hashes(p.current))) throw new Error('Target changed after planning: ' + p.entry.name);
    try {
      fs.mkdirSync(p.destination, { recursive: true });
      for (const [name, bytes] of Object.entries(p.desired)) {
        const file = within(p.destination, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      // Retired files are already in the verified external backup; unlink only exact files.
      for (const name of Object.keys(p.current)) if (!(name in p.desired)) fs.unlinkSync(within(p.destination, name));
      const installedHashes = hashes(tree(p.destination));
      if (!same(installedHashes, hashes(p.desired))) throw new Error('Readback mismatch: ' + p.entry.name);
      fs.writeFileSync(within(p.destination, LOCK), JSON.stringify({ schemaVersion: 1, name: p.entry.name, source: p.entry.source, sourceRoot: source, sourceHashes: hashes(p.raw), installedHashes }, null, 2) + '\n');
    } catch (error) {
      for (const name of Object.keys(p.desired)) {
        const file = within(p.destination, name);
        if (!(name in p.current) && fs.existsSync(file)) fs.unlinkSync(file);
      }
      for (const [name, bytes] of Object.entries(p.current)) {
        const file = within(p.destination, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      const lockFile = within(p.destination, LOCK);
      const savedLock = within(batch, path.join(p.entry.name, LOCK));
      if (fs.existsSync(savedLock)) fs.copyFileSync(savedLock, lockFile);
      else if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      if (!same(hashes(tree(p.destination)), hashes(p.current))) throw new Error('Restore mismatch; stop and recover from ' + batch, { cause: error });
      throw new Error('Skill restored after failure: ' + p.entry.name + '; backup=' + batch, { cause: error });
    }
  }
  return { backup: batch, skills: plans.map(p => ({ name: p.entry.name, state: 'in-sync' })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    const fields = { '--source-root': 'sourceRoot', '--target-root': 'targetRoot', '--backup-root': 'backupRoot', '--catalog': 'catalog', '--host': 'host' };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply' || args[i] === '--adopt') options[args[i].slice(2)] = true;
      else if (fields[args[i]] && args[i + 1]) options[fields[args[i]]] = args[++i];
      else throw new Error('Unknown or incomplete argument: ' + args[i]);
    }
    console.log(JSON.stringify(syncSkills(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
