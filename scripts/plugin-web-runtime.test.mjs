import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { WEB_RUNTIME_MODULES, webRuntimeVitePlugin, pluginWebRuntimeProxy, pluginEntryStyles } from './lib/plugin-web-runtime.mjs';
import { WEB_RUNTIME_KEY, WEB_RUNTIME_ABI, missingWebRuntimeImports } from '../plugins/contracts/plugin-sdk/web-runtime.mjs';
import { finalizeSelectedPluginWebArtifacts } from './build-plugin-packages.mjs';
import { buildPluginWebPackages, allWebPluginPackages } from './build-plugin-web-packages.mjs';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const hash = value => createHash('sha256').update(value).digest('hex');

test('selected plugin uses the exact shell Vue/store namespaces and keeps its own lazy/CSS/font/worker resources', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'node_modules/.rabi-web-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = path.join(directory, 'store.mjs');
  await fs.writeFile(store, "import {ref} from 'vue';export const shared=ref(1);export const unused='do not require this export';");
  const shell = path.join(directory, 'shell.mjs');
  await fs.writeFile(shell, `import namespaces from 'virtual:rabi-web-runtime';globalThis[${JSON.stringify(WEB_RUNTIME_KEY)}]={abi:${JSON.stringify(WEB_RUNTIME_ABI)},modules:namespaces};export {namespaces};`);
  const records = [{ id: 'vue', specifier: 'vue' }, { id: 'store', source: path.relative(root, store).replaceAll('\\', '/') }];
  const shellOutput = path.join(directory, 'shell');
  await build({ configFile: false, root, logLevel: 'error', plugins: [webRuntimeVitePlugin(root, records)], build: { target: 'esnext', outDir: shellOutput, emptyOutDir: true,
    rollupOptions: { input: shell, preserveEntrySignatures: 'exports-only', output: { entryFileNames: 'shell.mjs' } } } });
  const runtime = JSON.parse(await fs.readFile(path.join(shellOutput, 'assets/web-runtime.json'), 'utf8'));
  assert(runtime.modules.find(module => module.id === 'vue').exports.includes('ref'));
  const shellModule = await import(pathToFileURL(path.join(shellOutput, 'shell.mjs')).href);
  const plugin = path.join(directory, 'plugin.mjs');
  await fs.writeFile(path.join(directory, 'lazy.mjs'), 'export const delayed=7;');
  await fs.writeFile(path.join(directory, 'worker.mjs'), 'self.onmessage=()=>self.postMessage(1);');
  await fs.writeFile(path.join(directory, 'font.woff2'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(path.join(directory, 'style.css'), '@font-face{font-family:fixture;src:url(./font.woff2)}.fixture{background:url(./image.svg)}');
  await fs.writeFile(plugin, `import {ref} from 'vue';import {shared} from './store.mjs';import './style.css';export {ref,shared};export const lazy=()=>import('./lazy.mjs');export const worker=()=>new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});`);
  const proxy = pluginWebRuntimeProxy(root, runtime), pluginOutput = path.join(directory, 'plugin');
  await build({ configFile: false, root, base: './', logLevel: 'error', plugins: [proxy], build: { target: 'esnext', assetsInlineLimit: 0, outDir: pluginOutput, emptyOutDir: true,
    rollupOptions: { input: plugin, preserveEntrySignatures: 'exports-only', output: { entryFileNames: 'client.mjs' } } } });
  const built = await fs.readFile(path.join(pluginOutput, 'client.mjs'), 'utf8');
  assert(!/[\"']\/assets\//.test(built), 'no quoted absolute shell asset URL'); assert(!built.includes('function createApp'));
  const selected = await import(pathToFileURL(path.join(pluginOutput, 'client.mjs')).href);
  assert.equal(selected.ref, shellModule.namespaces.vue.ref); assert.equal(selected.shared, shellModule.namespaces.store.shared);
  selected.shared.value = 9; assert.equal(shellModule.namespaces.store.shared.value, 9);
  const required = proxy.requiredImports();
  assert.equal(missingWebRuntimeImports(required, globalThis[WEB_RUNTIME_KEY]).length, 0);
  assert(required.imports.find(item => item.id === 'store').exports.includes('shared'));
  assert(!required.imports.find(item => item.id === 'store').exports.includes('unused'));
  const assets = await fs.readdir(path.join(pluginOutput, 'assets'));
  for (const extension of ['.css', '.woff2', '.svg', '.js']) assert(assets.some(file => file.endsWith(extension)), extension);
  assert.equal((await selected.lazy()).delayed, 7);
});

test('selected finalizer retains native bytes and scopes new evidence to selected Web files', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'node_modules/.rabi-web-finalize-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output'), packageRoot = path.join(output, 'packages/example.web/1.0.0');
  await fs.mkdir(path.join(packageRoot, 'web'), { recursive: true }); await fs.mkdir(path.join(output, 'contracts'), { recursive: true });
  await fs.writeFile(path.join(directory, 'source.txt'), 'native original');
  await fs.writeFile(path.join(packageRoot, 'manager.mjs'), 'export const native=true;');
  const source = path.relative(root, path.join(directory, 'source.txt')).replaceAll('\\', '/');
  const nativeFiles = [{ path: 'packages/example.web/1.0.0/manager.mjs', sha256: hash('export const native=true;') }];
  const inputFiles = [{ path: source, sha256: hash('native original') }];
  const evidence = { schemaVersion: 1, scope: 'selected-packages', copied: ['example.web@1.0.0'], inputSelections: [source],
    inputs: { files: inputFiles, sha256: hash(JSON.stringify(inputFiles)) }, artifacts: { files: nativeFiles, sha256: hash(JSON.stringify(nativeFiles)) } };
  await fs.writeFile(path.join(output, 'build-evidence.json'), JSON.stringify(evidence));
  const module = { schemaVersion: 1, pluginId: 'example.web', version: '1.0.0', runtime: { abi: WEB_RUNTIME_ABI, imports: [] } };
  const bytes = JSON.stringify(module); await fs.writeFile(path.join(packageRoot, 'web/module.json'), bytes);
  const result = await finalizeSelectedPluginWebArtifacts(root, { outputRoot: output,
    packages: [{ pluginId: 'example.web', version: '1.0.0', path: 'packages/example.web/1.0.0/web/module.json', manifestSha256: hash(bytes) }], inputs: [], runtimeManifestSha256: 'a'.repeat(64) });
  assert.deepEqual(result.inputs, evidence.inputs); assert.equal(result.scope, 'selected-packages');
  assert.equal(result.web.parentArtifactSha256, evidence.artifacts.sha256);
  assert(result.artifacts.files.some(item => item.path.endsWith('web/module.json')));
  await fs.writeFile(path.join(packageRoot, 'manager.mjs'), 'unexpected native change');
  await assert.rejects(finalizeSelectedPluginWebArtifacts(root, { outputRoot: output, packages: result.web.packages, inputs: [] }), /unrelated native artifact/);
});


test('official selected Web producer builds a complete package beside the original native receipt', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'node_modules/.rabi-selected-web-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'src/plugins/example.web'), output = path.join(directory, 'output');
  const packaged = path.join(output, 'packages/example.web/1.0.0');
  await fs.mkdir(path.join(source, 'web'), { recursive: true }); await fs.mkdir(path.join(directory, 'ribiwebgui'));
  await fs.mkdir(path.join(packaged, 'web'), { recursive: true }); await fs.mkdir(path.join(output, 'contracts'));
  await fs.writeFile(path.join(directory, 'package.json'), '{"name":"fixture","type":"module"}'); await fs.writeFile(path.join(directory, 'package-lock.json'), '{}');
  for (const relative of ['scripts/build-plugin-web-packages.mjs', 'scripts/lib/plugin-web-runtime.mjs', 'plugins/contracts/plugin-sdk/web-builder.mjs', 'plugins/contracts/plugin-sdk/web-runtime.mjs']) {
    await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true }); await fs.copyFile(path.join(root, relative), path.join(directory, relative));
  }
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'example.web', rabi: { webSource: 'web/entry.mjs' } }));
  await fs.writeFile(path.join(source, 'rabi.plugin.json'), JSON.stringify({ id: 'example.web', version: '1.0.0' }));
  await fs.writeFile(path.join(source, 'web/entry.mjs'), "import {ref} from 'vue';export function activate(){return ref(1)};export const worker=()=>new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});");
  await fs.writeFile(path.join(source, 'web/worker-math.mjs'), 'export const value=3;');
  await fs.writeFile(path.join(source, 'web/worker.mjs'), "import {value} from './worker-math.mjs';self.onmessage=()=>self.postMessage(value);");
  await fs.writeFile(path.join(directory, 'native.txt'), 'native source'); await fs.writeFile(path.join(packaged, 'manager.mjs'), 'export const original=true;');
  const inputs = [{ path: 'native.txt', sha256: hash('native source') }], artifacts = [{ path: 'packages/example.web/1.0.0/manager.mjs', sha256: hash('export const original=true;') }];
  await fs.writeFile(path.join(output, 'build-evidence.json'), JSON.stringify({ schemaVersion: 1, kind: 'plugin-build', scope: 'selected-packages', copied: ['example.web@1.0.0'],
    inputSelections: ['native.txt'], inputs: { files: inputs, sha256: hash(JSON.stringify(inputs)) }, artifacts: { files: artifacts, sha256: hash(JSON.stringify(artifacts)) } }));
  const runtimeManifest = path.join(directory, 'runtime.json'); await fs.writeFile(runtimeManifest, JSON.stringify({ schemaVersion: 1, abi: WEB_RUNTIME_ABI, modules: [{ id: 'vue', specifier: 'vue', exports: ['ref'] }] }));
  const built = await buildPluginWebPackages(directory, { packages: ['example.web'], outputDirectory: output, runtimeManifest });
  assert.equal(built.receipt.web.kind, 'package-closures'); assert.equal(built.packages.length, 1);
  assert.equal(await fs.readFile(path.join(packaged, 'manager.mjs'), 'utf8'), 'export const original=true;');
  const module = JSON.parse(await fs.readFile(path.join(packaged, 'web/module.json'), 'utf8'));
  assert.deepEqual(module.backend, { pluginId: 'example.web', version: '1.0.0' });
  assert.equal(module.entry, 'client.mjs'); assert(module.files.some(file => file.path === 'client.mjs'));
  assert.equal(module.runtime.imports[0].id, 'vue');
  for (const name of ['src/plugins/example.web/web/worker.mjs', 'src/plugins/example.web/web/worker-math.mjs']) assert(built.receipt.web.inputs.some(file => file.path === name), name);
  assert(!/['"]\/assets\//.test(await fs.readFile(path.join(packaged, 'web/client.mjs'), 'utf8')));
  // Normal full scope selects every Web source from the catalog, independent of enabled state.
  const second = path.join(directory, 'src/plugins/example.second');
  await fs.mkdir(path.join(second, 'web'), { recursive: true });
  await fs.writeFile(path.join(second, 'package.json'), JSON.stringify({ name: 'example.second', rabi: { webSource: 'web/entry.mjs' } }));
  await fs.writeFile(path.join(second, 'rabi.plugin.json'), JSON.stringify({ id: 'example.second', version: '1.0.0' }));
  await fs.writeFile(path.join(second, 'web/entry.mjs'), 'export function activate(){}');
  const secondPackage = path.join(output, 'packages/example.second/1.0.0'); await fs.mkdir(secondPackage, { recursive: true });
  await fs.writeFile(path.join(secondPackage, 'manager.mjs'), 'export const second=true;');
  const nativeOnly = path.join(directory, 'src/plugins/example.native'); await fs.mkdir(nativeOnly, { recursive: true });
  await fs.writeFile(path.join(nativeOnly, 'package.json'), JSON.stringify({ name: 'example.native' }));
  await fs.mkdir(path.join(directory, 'plugins'), { recursive: true });
  await fs.writeFile(path.join(directory, 'plugins/source-catalog.json'), JSON.stringify({schemaVersion:1,plugins:[
    {sourceId:'example.web',ecosystem:'rabiroute'},{sourceId:'example.second',ecosystem:'rabiroute'},
    {sourceId:'example.native',ecosystem:'rabiroute'},{sourceId:'external.dsh',ecosystem:'dsh'}]}));
  const originalReceipt = JSON.parse(await fs.readFile(path.join(output, 'build-evidence.json'), 'utf8'));
  const nextFiles = [...originalReceipt.artifacts.files, {path:'packages/example.second/1.0.0/manager.mjs',sha256:hash('export const second=true;')}].sort((a,b)=>a.path.localeCompare(b.path));
  originalReceipt.copied.push('example.second@1.0.0');originalReceipt.artifacts={files:nextFiles,sha256:hash(JSON.stringify(nextFiles))};
  await fs.writeFile(path.join(output,'build-evidence.json'),JSON.stringify(originalReceipt));
  assert.deepEqual(await allWebPluginPackages(directory),['example.second','example.web']);
  const all = await buildPluginWebPackages(directory,{allWeb:true,outputDirectory:output,runtimeManifest});
  assert.equal(all.packages.length,2);assert.equal(all.receipt.web.packages.length,2);
  assert(all.receipt.web.inputs.some(file=>file.path==='plugins/source-catalog.json'));
  for(const id of ['example.web','example.second']){const closure=JSON.parse(await fs.readFile(path.join(output,'packages',id,'1.0.0/web/module.json'),'utf8'));assert.equal(closure.kind,'rabi-plugin-web');assert.equal(closure.pluginId,id);}
});


test('entry CSS contains static dependencies while lazy page CSS remains demand-loaded', () => {
  assert.deepEqual(pluginEntryStyles({ entry: { isEntry: true, css: ['assets/main.css'], imports: ['shared'], dynamicImports: ['lazy'] },
    shared: { css: ['assets/shared.css'] }, lazy: { css: ['assets/lazy.css'] } }), ['assets/main.css', 'assets/shared.css']);
});


test('an undeclared singleton subpath cannot silently bundle another Vue runtime', async () => {
  const proxy = pluginWebRuntimeProxy(root, { schemaVersion: 1, abi: WEB_RUNTIME_ABI, modules: [{ id: 'vue', specifier: 'vue', exports: ['ref'] }] });
  const context = { error(message) { throw new Error(message); } };
  assert.equal(await proxy.resolveId.call(context, 'vue', '/fixture/plugin.mjs'), '\0rabi-web-proxy:vue');
  await assert.rejects(proxy.resolveId.call(context, 'vue/dist/vue.runtime.esm-bundler.js', '/fixture/plugin.mjs'), /missing singleton namespace/);
  assert.equal(await proxy.resolveId.call(context, '@vue/compiler-dom', '/fixture/plugin.mjs'), undefined, 'a compiler utility is not another UI runtime singleton');
});


test('independent bundles register saves and translations on the exact shell owners', async t => {
  const directory = await fs.mkdtemp(path.join(root, 'node_modules/.rabi-web-owner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const shell = path.join(directory, 'shell.mjs');
  await fs.writeFile(shell, `import namespaces from 'virtual:rabi-web-runtime';globalThis[${JSON.stringify(WEB_RUNTIME_KEY)}]={abi:${JSON.stringify(WEB_RUNTIME_ABI)},modules:namespaces};export {namespaces};`);
  const records = WEB_RUNTIME_MODULES.filter(item => ['vue','rabi.page-save','rabi.translations'].includes(item.id));
  const shellOutput = path.join(directory, 'shell');
  await build({configFile:false,root,logLevel:'error',plugins:[webRuntimeVitePlugin(root,records)],build:{target:'esnext',outDir:shellOutput,emptyOutDir:true,rollupOptions:{input:shell,preserveEntrySignatures:'exports-only',output:{entryFileNames:'shell.mjs'}}}});
  const runtime = JSON.parse(await fs.readFile(path.join(shellOutput,'assets/web-runtime.json'),'utf8'));
  const actual = await import(pathToFileURL(path.join(shellOutput,'shell.mjs')).href);
  const plugin = path.join(directory,'plugin.mjs');
  const relativeOwner=path.relative(directory,path.join(root,'ribiwebgui/src/pageSaveAction.ts')).replaceAll('\\','/');
  await fs.writeFile(plugin, `import {registerPageSaveAction as relativeRegister} from ${JSON.stringify(relativeOwner.startsWith('.')?relativeOwner:'./'+relativeOwner)};import {registerPageSaveAction as aliasRegister} from '@/pageSaveAction';export {relativeRegister,aliasRegister};import {ref} from 'vue';import {pageSaveAction,registerPageSaveAction} from ${JSON.stringify(path.join(root,'ribiwebgui/src/pageSaveAction.ts'))};import {registerPluginTranslations} from ${JSON.stringify(path.join(root,'ribiwebgui/src/i18n/translationRegistry.ts'))};export {registerPageSaveAction};export function activate(){const offSave=registerPageSaveAction({dirty:ref(true),ready:ref(true),saving:ref(false),save:async()=>{globalThis.__rabiSaveCalls=(globalThis.__rabiSaveCalls??0)+1}});const offCopy=registerPluginTranslations('fixture.web',{en:{'fixture text':'shared text'}});return()=>{offSave();offCopy()}}`);
  const pluginOutput=path.join(directory,'plugin');
  await build({configFile:false,root,base:'./',logLevel:'error',plugins:[pluginWebRuntimeProxy(root,runtime)],resolve:{alias:{'@':path.join(root,'ribiwebgui/src')}},build:{target:'esnext',outDir:pluginOutput,emptyOutDir:true,rollupOptions:{input:plugin,preserveEntrySignatures:'exports-only',output:{entryFileNames:'client.mjs'}}}});
  const selected=await import(pathToFileURL(path.join(pluginOutput,'client.mjs')).href);
  assert.equal(selected.registerPageSaveAction,actual.namespaces['rabi.page-save'].registerPageSaveAction);
  assert.equal(selected.relativeRegister,selected.registerPageSaveAction);assert.equal(selected.aliasRegister,selected.registerPageSaveAction);
  const off=selected.activate();
  try {assert.equal(actual.namespaces['rabi.page-save'].pageSaveAction.value.dirty.value,true);await actual.namespaces['rabi.page-save'].pageSaveAction.value.save();assert.equal(globalThis.__rabiSaveCalls,1);assert.equal(actual.namespaces['rabi.translations'].pluginTranslation('en','fixture text'),'shared text');}
  finally {off();delete globalThis.__rabiSaveCalls;}
  assert.equal(actual.namespaces['rabi.page-save'].pageSaveAction.value,null);
});

test('normal shell build exposes no static plugin business entries and official producer covers all 26 sources', async () => {
  const {resolveConfig}=await import('vite');
  const config=await resolveConfig({configFile:path.join(root,'ribiwebgui/vite.config.ts')},'build');
  assert.deepEqual(Object.keys(config.build.rollupOptions.input),['app']);
  assert.equal((await allWebPluginPackages(root)).length,26);
  const sync=await fs.readFile(path.join(root,'scripts/sync-plugin-web-bundles.mjs'),'utf8');
  assert.match(sync,/buildPluginWebPackages/);assert.match(sync,/allWeb: true/);assert(!sync.includes('export { activate } from'));
  for(const name of ['rabi.page-save','rabi.plugin-catalog','rabi.role-store','rabi.speech-store','rabi.plugin-pages','rabi.plugin-renderers','rabi.plugin-themes','rabi.translations'])assert(WEB_RUNTIME_MODULES.some(item=>item.id===name));
  assert(WEB_RUNTIME_MODULES.filter(item=>item.source).every(item=>!item.source.startsWith('src/plugins/')),'business packages do not become shell namespaces');
});


test('the shared shell runtime graph contains existing state owners without plugin business views', async t => {
  const directory=await fs.mkdtemp(path.join(root,'node_modules/.rabi-shell-graph-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const shell=path.join(directory,'runtime.mjs');await fs.writeFile(shell,"import namespaces from 'virtual:rabi-web-runtime';export {namespaces};");
  const emitted=await build({configFile:false,root,logLevel:'error',plugins:[webRuntimeVitePlugin(root)],resolve:{alias:{'@':path.join(root,'ribiwebgui/src'),'@shared':path.join(root,'src/shared'),'@rabiroute/host-api':path.join(root,'src')}},
    build:{target:'esnext',write:false,rollupOptions:{input:shell,preserveEntrySignatures:'exports-only'}}});
  const outputs=Array.isArray(emitted)?emitted:[emitted],moduleIds=new Set(outputs.flatMap(result=>result.output.filter(item=>item.type==='chunk').flatMap(item=>Object.keys(item.modules))));
  assert([...moduleIds].some(id=>id.replaceAll('\\','/').endsWith('/ribiwebgui/src/pageSaveAction.ts')));
  assert([...moduleIds].some(id=>id.replaceAll('\\','/').endsWith('/ribiwebgui/src/pluginCatalogStore.ts')));
  assert.deepEqual([...moduleIds].filter(id=>/\/src\/plugins\/[^/]+\/web\/.*\.vue(?:\?|$)/.test(id.replaceAll('\\','/'))),[], 'shell namespace graph must not eagerly carry plugin business views');
});
