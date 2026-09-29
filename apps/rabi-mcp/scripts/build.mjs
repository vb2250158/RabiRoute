import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = data => createHash('sha256').update(data).digest('hex');
export async function assertLocalDirectory(value) {
  if (!path.isAbsolute(value) || /^[/\\]{2}/.test(value)) throw new Error('An absolute local directory is required.');
  const real = await fs.realpath(value);
  if (/^[/\\]{2}/.test(real)) throw new Error('Network paths are not allowed.');
  if (process.platform === 'win32') {
    const drive = path.parse(real).root.slice(0, 2);
    const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', "$d=Get-CimInstance Win32_LogicalDisk | Where-Object DeviceID -eq $env:RABI_BUILD_DRIVE; if (!$d -or $d.DriveType -ne 3) { exit 1 }"], { env: { ...process.env, RABI_BUILD_DRIVE: drive }, encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (probe.error || probe.status !== 0) throw new Error('Build directory must reside on a verified fixed local disk.');
  }
  return real;
}
async function regular(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Build inputs must be regular files.');
  return fs.readFile(file);
}
export async function buildArtifact(output) {
  if (!output || !path.isAbsolute(output)) throw new Error('Pass an explicit absolute --output directory.');
  await assertLocalDirectory(appRoot);
  const destination = path.resolve(output);
  await assertLocalDirectory(path.dirname(destination));
  try { await fs.lstat(destination); throw new Error('Output already exists; refusing overwrite.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const required = ['package.json', 'package-lock.json', 'README.md', 'README_en.md', 'knowledge-mcp.mjs'];
  const inputs = new Map();
  for (const name of required) inputs.set(name, await regular(path.join(appRoot, name)));
  const packageJson = JSON.parse(inputs.get('package.json'));
  const lock = JSON.parse(inputs.get('package-lock.json'));
  if (lock.packages?.['']?.dependencies?.['@modelcontextprotocol/sdk'] !== packageJson.dependencies?.['@modelcontextprotocol/sdk']) throw new Error('Lock does not match the SDK dependency.');
  const { build } = await import('esbuild');
  await fs.mkdir(destination); // Exclusive: never remove or reuse a prior artifact.
  const result = await build({ absWorkingDir: appRoot, entryPoints: ['knowledge-mcp.mjs'], outfile: path.join(destination, 'knowledge-mcp.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', metafile: true, logLevel: 'silent' });
  for (const [name, bytes] of inputs) if (name !== 'knowledge-mcp.mjs') await fs.writeFile(path.join(destination, name), bytes, { flag: 'wx' });
  const bundled = await fs.readFile(path.join(destination, 'knowledge-mcp.mjs'), 'utf8');
  if (/(?:from\s*|import\s*\()\s*['"]\.\.?\//.test(bundled)) throw new Error('Artifact retains a relative runtime import.');
  const install = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund --bin-links=false'], { cwd: destination, stdio: 'inherit', windowsHide: true })
    : spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'], { cwd: destination, stdio: 'inherit' });
  if (install.error || install.status !== 0) throw new Error('Artifact dependency installation failed; incomplete output retained for inspection.');
  const sourceInputs = [];
  for (const name of Object.keys(result.metafile.inputs).sort()) {
    const bytes = await regular(path.resolve(appRoot, name));
    sourceInputs.push({ path: name.replaceAll('\\', '/'), sha256: digest(bytes), size: bytes.length });
  }
  const files = [];
  async function visit(directory, prefix = '') {
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + item.name;
      const absolute = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('Artifact must not contain symbolic links.');
      if (item.isDirectory()) await visit(absolute, relative + '/');
      else { const bytes = await regular(absolute); files.push({ path: relative, sha256: digest(bytes), size: bytes.length }); }
    }
  }
  await visit(destination);
  const packagingInputs = [...inputs].map(([name, bytes]) => ({ path: name, sha256: digest(bytes), size: bytes.length }));
  const manifest = { schemaVersion: 1, packagingInputs, name: packageJson.name, version: packageJson.version, entry: 'knowledge-mcp.mjs', localHostOnly: true, installed: false, sourceInputs, files };
  await fs.writeFile(path.join(destination, 'artifact-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output: destination, files: files.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') { console.error('Usage: node scripts/build.mjs --output <new-absolute-local-directory>'); process.exitCode = 1; }
  else { try { console.log(JSON.stringify(await buildArtifact(args[1]))); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
