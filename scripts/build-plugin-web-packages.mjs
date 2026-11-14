import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildPluginWebPackage } from '../plugins/contracts/plugin-sdk/web-builder.mjs';
import { pluginSourceDirectory } from './lib/plugin-source-layout.mjs';
import { finalizeSelectedPluginWebArtifacts } from './build-plugin-packages.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Only source files inside the selected build root belong in its input receipt. */
export function webInputRelativePath(root, file, pathApi = path) {
  const relative = pathApi.relative(root, file);
  if (!relative || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + pathApi.sep)) return undefined;
  return relative.replaceAll('\\', '/');
}

/** The catalog owns the complete Web source set, including disabled profile instances. */
export async function allWebPluginPackages(root) {
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'plugins/source-catalog.json'), 'utf8'));
  const selected = [];
  for (const source of catalog.plugins) {
    if (source.ecosystem !== 'rabiroute') continue;
    const directory = pluginSourceDirectory(root, source.sourceId);
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    if (metadata.rabi?.webSource) selected.push(source.sourceId);
  }
  return selected.sort();
}

/** Official selected-package Web producer. It consumes the unchanged native receipt. */
export async function buildPluginWebPackages(root = process.cwd(), options = {}) {
  root = path.resolve(root);
  const selected = options.allWeb ? await allWebPluginPackages(root) : [...new Set(options.packages ?? [])];
  if (!selected.length) throw new Error('Select at least one plugin package.');
  const outputRoot = path.resolve(options.outputDirectory ?? path.join(root, 'dist/plugins'));
  const runtimeBytes = await fs.readFile(options.runtimeManifest ?? path.join(root, 'ribiwebgui/dist/assets/web-runtime.json'));
  const runtime = JSON.parse(runtimeBytes);
  const evidence = JSON.parse(await fs.readFile(path.join(outputRoot, 'build-evidence.json'), 'utf8'));
  if (!['selected-packages', 'profile'].includes(evidence.scope)) throw new Error('Selected Web builds require the original native package evidence.');
  const records = [], inputPaths = new Set(['package.json', 'package-lock.json', 'scripts/build-plugin-web-packages.mjs',
    'scripts/lib/plugin-web-runtime.mjs', 'plugins/contracts/plugin-sdk/web-builder.mjs', 'plugins/contracts/plugin-sdk/web-runtime.mjs']);
  if (options.allWeb) inputPaths.add('plugins/source-catalog.json');
  for (const id of selected) {
    const source = pluginSourceDirectory(root, id);
    const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'rabi.plugin.json'), 'utf8'));
    if (metadata.name !== id || manifest.id !== id || !metadata.rabi?.webSource || !evidence.copied.includes(id + '@' + manifest.version)) throw new Error('Build the selected native package before its Web closure: ' + id);
    const packageRoot = path.join(outputRoot, 'packages', encodeURIComponent(id), manifest.version);
    const staged = path.join(outputRoot, '.web-package-' + randomUUID());
    try {
      const built = await buildPluginWebPackage({ sourceDirectory: source, outputDirectory: staged, runtimeCatalog: runtime,
        referenceRoot: root, aliases: { '@': path.join(root, 'ribiwebgui/src'), '@shared': path.join(root, 'src/shared'), '@rabiroute/host-api': path.join(root, 'src') } });
      for (const record of built.inputs) {
        const name = webInputRelativePath(root, record.path);
        if (name !== undefined) inputPaths.add(name);
      }
      const webRoot = path.join(packageRoot, 'web');
      if (!webRoot.startsWith(outputRoot + path.sep)) throw new Error('Selected Web output escaped its package root.');
      await fs.rm(webRoot, { recursive: true, force: true });
      await fs.rename(staged, webRoot);
      records.push({ pluginId: id, version: manifest.version, path: path.relative(outputRoot, path.join(webRoot, 'module.json')).replaceAll('\\', '/'), manifestSha256: built.manifestSha256 });
    } finally { await fs.rm(staged, { recursive: true, force: true }); }
  }
  const inputs = [];
  for (const name of [...inputPaths].sort()) { if (!(await fs.stat(path.join(root, name))).isFile()) continue; const bytes = await fs.readFile(path.join(root, name)); inputs.push({ path: name, sha256: hash(bytes) }); }
  const receipt = await finalizeSelectedPluginWebArtifacts(root, { outputRoot, packages: records, inputs,
    runtimeManifestSha256: hash(runtimeBytes) });
  return { outputRoot, packages: records, receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { packages: [] };
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--all') { options.allWeb = true; continue; }
    const value = process.argv[++index];
    if (!value || !['--package', '--output-directory', '--runtime-manifest'].includes(flag)) throw new Error('Use --all or --package, --output-directory and --runtime-manifest.');
    if (flag === '--package') options.packages.push(value);
    else if (flag === '--output-directory') options.outputDirectory = value;
    else options.runtimeManifest = value;
  }
  const result = await buildPluginWebPackages(process.cwd(), options);
  console.log('Built ' + result.packages.length + ' independent Web package closures.');
}
