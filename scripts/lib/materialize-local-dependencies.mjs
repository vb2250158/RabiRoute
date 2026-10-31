import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Local package paths must be relative.');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error('Local package path escaped its owner.');
  return absolute;
}
function assertNoLinkedParents(root, target) {
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Local dependency parent is a symbolic link.');
  }
}
function targets(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const child of value) targets(child, output);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) targets(child, output);
  return output;
}
export function assertPackageEntries(packageRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const required = [...targets(pkg.exports), ...[pkg.main, pkg.module, pkg.types, pkg.typings].filter(Boolean),
    ...targets(typeof pkg.bin === 'string' ? pkg.bin : pkg.bin || {})];
  const paths = [];
  function walk(root, prefix = '') { for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = prefix + item.name, absolute = path.join(root, item.name);
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Local package cannot contain symbolic links.');
    if (item.isDirectory()) walk(absolute, relative + '/'); else if (item.isFile()) paths.push(relative);
  } }
  walk(packageRoot);
  for (const target of required) {
    const relative = target.replace(/^\.\//, '');
    inside(packageRoot, relative);
    if (relative.includes('*')) {
      const pattern = new RegExp('^' + relative.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      if (!paths.some(file => pattern.test(file))) throw new Error(`Local package export has no packaged files: ${target}`);
    } else if (!fs.existsSync(path.join(packageRoot, relative)) || !fs.statSync(path.join(packageRoot, relative)).isFile()) {
      throw new Error(`Local package entry is missing: ${target}`);
    }
  }
  return { name: pkg.name, entryTargets: [...new Set(required)], files: paths.sort().map(file => ({ path: file, sha256: hash(path.join(packageRoot, file)) })) };
}
export function materializeLocalDependencies({ repo, payload, packList }) {
  repo = path.resolve(repo); payload = path.resolve(payload);
  if (repo === payload || payload.startsWith(repo + path.sep)) throw new Error('Release payload must be outside the source repository.');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const records = [];
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Invalid local dependency package name.');
    const relative = spec.slice(5), source = inside(repo, relative);
    assertNoLinkedParents(repo, path.join(source, 'package.json'));
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (sourceManifest.name !== name) throw new Error('Local dependency package name mismatch.');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-local-package-'));
    try {
      let files;
      if (packList) files = packList(source);
      else {
        const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
        const cli = fs.existsSync(npmCli) ? { command: process.execPath, args: [npmCli] } : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };
        const result = spawnSync(cli.command, [...cli.args, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(temporary, 'npm-cache')],
          { cwd: source, encoding: 'utf8', windowsHide: true, shell: cli.command.endsWith('.cmd'), timeout: 60_000 });
        if (result.status !== 0) throw new Error('Unable to inspect local dependency npm package contents.');
        files = JSON.parse(result.stdout)[0].files.map(file => file.path);
      }
      const staged = path.join(temporary, 'package'); fs.mkdirSync(staged);
      const frozen = files.map(file => {
        const absolute = inside(source, file); assertNoLinkedParents(source, absolute);
        if (!fs.lstatSync(absolute).isFile() || fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Invalid packaged dependency file.');
        const destination = inside(staged, file); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(absolute, destination);
        const sha256 = hash(absolute); if (hash(destination) !== sha256) throw new Error('Dependency snapshot changed while copying.');
        return { path: file, sha256 };
      });
      const inspection = assertPackageEntries(staged);
      for (const file of frozen) if (hash(inside(source, file.path)) !== file.sha256) throw new Error('Local dependency source changed during snapshot.');
      const packagedSource = inside(payload, relative), installed = inside(path.join(payload, 'node_modules'), name);
      for (const destination of [packagedSource, installed]) {
        assertNoLinkedParents(payload, destination);
        if (fs.existsSync(destination)) {
          const stat = fs.lstatSync(destination); if (stat.isSymbolicLink()) fs.unlinkSync(destination); else fs.rmSync(destination, { recursive: true });
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(staged, destination, { recursive: true });
        const actual = assertPackageEntries(destination); if (JSON.stringify(actual.files) !== JSON.stringify(inspection.files)) throw new Error('Materialized local dependency does not match its snapshot.');
      }
      records.push({ name, sourceRelativePath: relative, ...inspection });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  return records;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(materializeLocalDependencies({ repo: process.argv[2], payload: process.argv[3] }))); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Local dependency materialization failed.'); process.exitCode = 1; }
}
