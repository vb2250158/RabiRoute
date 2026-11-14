import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WEB_RUNTIME_ABI, WEB_RUNTIME_KEY } from './web-runtime.mjs';

const virtual = '\0rabi-web-runtime';
export function webRuntimeVitePlugin(root, modules, options = {}) {
  const resolved = new Map();
  return {
    name: 'rabi-shared-web-runtime',
    async buildStart() {
      for (const module of modules) {
        const target = module.specifier ?? path.join(root, module.source);
        const resolution = await this.resolve(target, options.importer ?? path.join(root, 'package.json'), { skipSelf: true });
        if (!resolution || resolution.external) this.error('Shared Web runtime module could not be resolved: ' + module.id);
        resolved.set(module.id, resolution.id);
      }
    },
    resolveId(id) { if (id === 'virtual:rabi-web-runtime') return virtual; },
    load(id) {
      if (id !== virtual) return;
      return modules.map((module, index) => 'import * as m' + index + ' from ' + JSON.stringify(resolved.get(module.id)) + ';').join('\n')
        + '\nexport default {' + modules.map((module, index) => JSON.stringify(module.id) + ':m' + index).join(',') + '};';
    },
    async generateBundle() {
      const collect = async (id, seen = new Set()) => {
        if (seen.has(id)) return [];
        seen.add(id);
        const info = this.getModuleInfo(id);
        const names = new Set(info?.exports?.filter(name => name !== '*') ?? []);
        for (const node of info?.ast?.body ?? []) if (node.type === 'ExportAllDeclaration' && !node.exported) {
          const target = await this.resolve(node.source.value, id, { skipSelf: true });
          if (target) for (const name of await collect(target.id, seen)) if (name !== 'default') names.add(name);
        }
        return [...names].sort();
      };
      const records = [];
      for (const module of modules) {
        const exports = await collect(resolved.get(module.id));
        if (!exports.length) this.error('Shared Web runtime has no recorded exports: ' + module.id);
        records.push({ id: module.id, ...(module.specifier ? { specifier: module.specifier } : { source: module.source }), exports });
      }
      this.emitFile({ type: 'asset', fileName: 'assets/web-runtime.json', source: JSON.stringify({ schemaVersion: 1, abi: WEB_RUNTIME_ABI, modules: records }, null, 2) + '\n' });
    }
  };
}

export function pluginWebRuntimeProxy(root, manifest) {
  if (manifest.schemaVersion !== 1 || manifest.abi !== WEB_RUNTIME_ABI || !Array.isArray(manifest.modules)) throw new Error('Read the original shared Web runtime manifest before building a selected plugin.');
  const modules = new Map(manifest.modules.map(module => [module.id, module]));
  const bySource = new Map(manifest.modules.filter(module => module.source).map(module => [path.resolve(root, module.source).replaceAll('\\', '/'), module.id]));
  const bySpecifier = new Map(manifest.modules.map(module => [module.specifier ?? module.id, module.id]));
  const proxyPrefix = '\0rabi-web-proxy:';
  const imports = new Map();
  return {
    name: 'rabi-plugin-web-runtime-proxy', enforce: 'pre',
    async resolveId(source, importer) {
      let id = bySpecifier.get(source);
      if (!id && importer && (source.startsWith('.') || path.isAbsolute(source))) {
        let filename = source.startsWith('.') ? path.resolve(path.dirname(importer.split('?')[0]), source) : source;
        filename = filename.replaceAll('\\', '/');
        id = bySource.get(filename) ?? bySource.get(filename + '.ts') ?? bySource.get(filename + '/index.ts');
      }
      if (id) return proxyPrefix + id;
      // A second copy of these UI singletons cannot share the shell's component
      // and injection state. This is a build dependency error, never an API gate.
      if (/^(?:vue|pinia|vue-router|vuetify)(?:\/|$)|^@vue\/(?:runtime-core|runtime-dom|reactivity)(?:\/|$)/.test(source)) {
        this.error('Use the shared runtime public import or declare this missing singleton namespace: ' + source);
      }
    },
    load(id) {
      if (!id.startsWith(proxyPrefix)) return;
      const module = modules.get(id.slice(proxyPrefix.length));
      const namespace = 'globalThis[' + JSON.stringify(WEB_RUNTIME_KEY) + '].modules[' + JSON.stringify(module.id) + ']';
      return 'const ns=' + namespace + ';\n' + module.exports.map((name, index) => name === 'default'
        ? 'export default ns.default;'
        : 'const e' + index + '=ns[' + JSON.stringify(name) + '];export {e' + index + ' as ' + name + '};').join('\n');
    },
    generateBundle(_options, bundle) {
      imports.clear();
      for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') for (const [id, module] of Object.entries(chunk.modules)) {
        if (!id.startsWith(proxyPrefix)) continue;
        const key = id.slice(proxyPrefix.length), names = imports.get(key) ?? new Set();
        for (const name of module.renderedExports) names.add(name);
        imports.set(key, names);
      }
    },
    requiredImports() { return { abi: manifest.abi, imports: [...imports].map(([id, names]) => ({ id, exports: [...names].sort() })).sort((a, b) => a.id.localeCompare(b.id)) }; }
  };
}


/** Only the entry/static graph needs immediate CSS. Dynamic chunks retain Vite's lazy CSS loading. */
export function pluginEntryStyles(manifest) {
  const seen = new Set(), styles = new Set();
  const visit = key => {
    if (seen.has(key)) return;
    seen.add(key); const entry = manifest[key];
    if (!entry) throw new Error('Selected Web manifest has a missing static import: ' + key);
    for (const filename of entry.css ?? []) styles.add(filename);
    for (const dependency of entry.imports ?? []) visit(dependency);
  };
  for (const [key, entry] of Object.entries(manifest)) if (entry.isEntry) visit(key);
  return [...styles].sort();
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const resourceTypes = { '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
async function resourceFiles(root, relative = '', contentTypes = {}) {
  const records = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) records.push(...await resourceFiles(root, name, contentTypes));
    else if (entry.isFile()) { const bytes = await fs.readFile(path.join(root, name)); records.push({ path: name, size: bytes.length, sha256: hash(bytes), contentType: contentTypes[path.extname(name).toLowerCase()] ?? resourceTypes[path.extname(name).toLowerCase()] ?? 'application/octet-stream' }); }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
async function ownToolchain(source) {
  const require = createRequire(path.join(source, 'package.json'));
  try {
    const vite = await import(pathToFileURL(require.resolve('vite')).href);
    const plugin = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href);
    return { build: vite.build ?? vite.default?.build, vue: plugin.default };
  } catch { throw new Error('Web builds need vite and @vitejs/plugin-vue in this plugin repository devDependencies, or an explicit toolchain.'); }
}

/** Standalone SDK producer: sourceDirectory may be any plugin repository. No Manager or monorepo is required. */
export async function buildPluginWebPackage(options = {}) {
  const source = path.resolve(options.sourceDirectory ?? process.cwd()), output = path.resolve(options.outputDirectory ?? path.join(source, 'dist/web')), referenceRoot = path.resolve(options.referenceRoot ?? source);
  const sourceWithinOutput = path.relative(output, source);
  if (!sourceWithinOutput || sourceWithinOutput !== '..' && !sourceWithinOutput.startsWith('..' + path.sep) && !path.isAbsolute(sourceWithinOutput) || output === path.parse(output).root) throw new Error('Web output must be its own build directory, not the plugin source or its parent.');
  if (options.runtimeCatalog === undefined) throw new Error('runtimeCatalog is required; read the target shell assets/web-runtime.json.');
  const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const identity = JSON.parse(await fs.readFile(path.join(source, 'rabi.plugin.json'), 'utf8'));
  const entry = options.entry ?? metadata.rabi?.webSource;
  if (typeof identity.id !== 'string' || typeof identity.version !== 'string' || typeof entry !== 'string') throw new Error('Provide the plugin id/version and rabi.webSource or explicit entry.');
  const input = path.resolve(source, entry), relativeEntry = path.relative(source, input);
  if (relativeEntry === '..' || relativeEntry.startsWith('..' + path.sep) || path.isAbsolute(relativeEntry)) throw new Error('The Web entry must belong to sourceDirectory.');
  const runtimeBytes = typeof options.runtimeCatalog === 'string' ? await fs.readFile(options.runtimeCatalog) : Buffer.from(JSON.stringify(options.runtimeCatalog));
  const catalog = JSON.parse(runtimeBytes), proxy = pluginWebRuntimeProxy(referenceRoot, catalog);
  const tools = options.toolchain ?? await ownToolchain(source);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const staged = await fs.mkdtemp(output + '.build-'), backup = output + '.previous-' + randomUUID();
  const captured = new Set();
  const captureInputs = () => ({ name: 'rabi-plugin-web-inputs', generateBundle() {
    for (const raw of [...this.getModuleIds(), ...this.getWatchFiles()]) { const file = raw.split('?')[0]; if (path.isAbsolute(file)) captured.add(file); }
  } });
  let previous = false, committed = false;
  try {
    await tools.build({ configFile: false, root: source, base: './', logLevel: options.logLevel ?? 'info',
      plugins: [tools.vue(), proxy, captureInputs()], worker: { plugins: () => [captureInputs()] },
      resolve: { alias: options.aliases ?? {} },
      build: { target: 'esnext', assetsInlineLimit: options.assetsInlineLimit, outDir: staged, emptyOutDir: true, manifest: true,
        rollupOptions: { preserveEntrySignatures: 'exports-only', input: { client: input },
          output: { entryFileNames: 'client.mjs', chunkFileNames: 'assets/[name]-[hash].mjs', assetFileNames: 'assets/[name]-[hash][extname]' } } }
    });
    const viteManifest = JSON.parse(await fs.readFile(path.join(staged, '.vite/manifest.json'), 'utf8'));
    await fs.rm(path.join(staged, '.vite'), { recursive: true, force: true });
    const files = await resourceFiles(staged, '', options.contentTypes ?? metadata.rabi?.webContentTypes ?? {});
    const manifest = { schemaVersion: 1, kind: 'rabi-plugin-web', pluginId: identity.id, version: identity.version, entry: 'client.mjs',
      runtime: proxy.requiredImports(), backend: { pluginId: identity.id, version: identity.version }, styles: pluginEntryStyles(viteManifest), files };
    await fs.writeFile(path.join(staged, 'module.json'), JSON.stringify(manifest, null, 2) + '\n');
    const inputs = [];
    for (const filename of [...captured].sort()) {
      if (!(await fs.stat(filename)).isFile()) continue;
      const underOutput = path.relative(output, filename);
      if (!underOutput || underOutput !== '..' && !underOutput.startsWith('..' + path.sep) && !path.isAbsolute(underOutput)) throw new Error('Web output would replace an input source file.');
      inputs.push({ path: filename, sha256: hash(await fs.readFile(filename)) });
    }
    try {
      const stat = await fs.stat(output);
      if (!stat.isDirectory()) throw new Error('Web output is not a build directory.');
      if ((await fs.readdir(output)).length) {
        let owned = false;
        try { const old = JSON.parse(await fs.readFile(path.join(output, 'module.json'), 'utf8')); owned = old.kind === 'rabi-plugin-web' && old.pluginId === identity.id; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!owned && path.basename(output) === 'web') {
          try { const parent = JSON.parse(await fs.readFile(path.join(path.dirname(output), 'rabi.plugin.json'), 'utf8')); owned = parent.id === identity.id && parent.version === identity.version; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!owned) throw new Error('Existing output does not belong to this plugin Web build or its native package.');
      }
      await fs.rename(output, backup); previous = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(staged, output); committed = true;
    if (previous) { await fs.rm(backup, { recursive: true, force: true }); previous = false; }
    return { outputDirectory: output, manifest, manifestSha256: hash(await fs.readFile(path.join(output, 'module.json'))),
      runtimeCatalogSha256: hash(runtimeBytes), inputs, toolchain: { node: process.version, builderSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))) } };
  } finally {
    if (!committed && previous) await fs.rename(backup, output);
    await fs.rm(staged, { recursive: true, force: true });
  }
}
