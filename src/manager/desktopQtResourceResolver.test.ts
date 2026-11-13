import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { buildDesktopQtPackage } from '../../scripts/build-desktop-qt-package.mjs';
import { PluginPackageStore } from './pluginPackageStore.js';
import { PluginPackageCatalog } from '../plugin-kernel/profile.js';
import { createDesktopResourceResolver } from './desktopQtResourceResolver.js';
import { LanAgentReleaseStore } from './lanAgentReleaseStore.js';
import { ComputerService } from '../../apps/rabi-agent/lib/computer-service.mjs';
import { DEFAULT_COMPUTER_SETTINGS } from '../../apps/rabi-agent/lib/computer-control-contract.mjs';
import { desktopResourceReference, sameDesktopResourceReference } from '../../apps/rabi-agent/lib/desktop-resource-reference.mjs';
const { NativeComputerClient } = createRequire(import.meta.url)('../../apps/rabi-agent/lib/computer-native-client.mjs');

async function sourceRuntime(root:string){
 const files={ 'python/python.exe':'synthetic interpreter bytes; never executed', 'python/python310._pth':'python310.zip\n.\n..\nLib/site-packages\nimport site\n',
  'python/LICENSE.txt':'Synthetic Python notice', 'python/Lib/site-packages/PySide6_Essentials-6.7.1.dist-info/METADATA':'Name: PySide6_Essentials\nVersion: 6.7.1\n',
  'python/Lib/site-packages/PySide6_Essentials-6.7.1.dist-info/licenses/LICENSE':'Synthetic Qt notice', 'python/Lib/site-packages/shiboken6-6.7.1.dist-info/METADATA':'Name: shiboken6\nVersion: 6.7.1\n',
  'python/Lib/site-packages/pyside6_essentials-6.12.0.dist-info/licenses/LicenseRef-Qt-Commercial.txt':'Synthetic long notice path; no binaries',
  'python/Lib/site-packages/PySide6/QtCore.pyd':'synthetic binary', 'rabiroute_tray/computer_control_overlay.py':'# unchanged synthetic presentation\n', 'rabiroute_tray/theme.py':'# theme\n', 'rabiroute_tray/themes/__init__.py':'# themes\n' };
 for(const [file,value]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),value);}
 return files;
}
async function fixture(t:test.TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qt-resource-package-')),runtime=path.join(root,'desktop-runtime'),managed=path.join(root,'packages');await sourceRuntime(runtime);
 t.diagnostic('qt-fixture: producer');
 const pin=await buildDesktopQtPackage({runtimeRoot:runtime,outputRoot:path.join(root,'candidate'),version:'0.1.1'});
 t.diagnostic('qt-fixture: import');
 const store=new PluginPackageStore({roots:[managed],managedRoot:managed,importRuntimeRoot:path.join(root,'imports')});await store.importDirectory(pin.outputRoot,()=>{});
 t.diagnostic('qt-fixture: imported');
 const catalog=new PluginPackageCatalog([managed]),owners=new Set<{stop():Promise<void>}>();t.after(async()=>{for(const owner of owners)await owner.stop();await catalog.dispose();await fs.rm(root,{recursive:true,force:true});});
 const native=new LanAgentReleaseStore({rootDir:root,agentRoot:path.join(root,'unused-sdk')});
 const resolve=createDesktopResourceResolver({native,packages:()=>catalog,runtimeRoot:path.join(root,'qt-snapshots')});return{root,runtime,managed,pin,store,catalog,native,resolve,owners};
}

test('official Qt producer preserves existing GUI/binary bytes and imports a complete declarative resource package',async t=>{
 const f=await fixture(t),descriptor=JSON.parse(await fs.readFile(path.join(f.pin.outputRoot,'computer-qt.json'),'utf8'));
 assert.equal(descriptor.protocol,'rabi-computer-overlay-jsonl@1');assert.equal(descriptor.dependencies.length,2);assert.ok(descriptor.notices.some((v:string)=>v.includes('PySide6')));
 assert.deepEqual(await fs.readFile(path.join(f.runtime,'python/python.exe')),await fs.readFile(path.join(f.pin.outputRoot,'runtime/python/python.exe')));
 assert.deepEqual(await fs.readFile(path.join(f.runtime,'rabiroute_tray/computer_control_overlay.py')),await fs.readFile(path.join(f.pin.outputRoot,'runtime/rabiroute_tray/computer_control_overlay.py')));
 const longest=descriptor.files.reduce((a:any,b:any)=>a.path.length>b.path.length?a:b).path;
 assert.ok(path.join(os.tmpdir(),'rr-qt',f.pin.revision,longest).length<260,'the full revision cache also fits the longest original Qt notice path');
 const packages=await f.store.list();assert.equal(packages[0].manifest.entries.desktop?.execution,'declarative');
 await assert.rejects(buildDesktopQtPackage({runtimeRoot:f.runtime,outputRoot:f.pin.outputRoot,version:'0.1.1'}),{code:'EEXIST'});
 if(process.platform==='win32'&&process.arch==='x64'){
  const release=await f.resolve({qtPackageRef:f.pin});assert.equal(release.version,'builtin');assert.equal(release.qtPackageRef?.revision,f.pin.revision);assert.ok('qtPresentation' in release.nativeOptions);assert.ok(release.nativeOptions.qtPresentation?.command.endsWith('python.exe'));
  await assert.rejects(f.resolve({qtPackageRef:{...f.pin,revision:'a'.repeat(64)}}),/exact imported identity/);
  assert.equal(await fs.stat(path.join(f.root,'data/lan-agent-release-signing-key.json')).then(()=>true,()=>false),false,'Qt-only import/resolve does not create an SDK signer');
 }
});

test('resource references keep Qt on a legacy Native-only update and compare the complete pair',()=>{
 const qt={id:'io.test.qt',version:'1',revision:'a'.repeat(64)},digest='b'.repeat(64);
 assert.deepEqual(desktopResourceReference(digest,{qtPackageRef:qt}),{digest,qtPackageRef:qt});
 assert.equal(desktopResourceReference({qtPackageRef:null},{digest,qtPackageRef:qt}).qtPackageRef,null);
 assert.equal(sameDesktopResourceReference({digest,qtPackageRef:qt},{digest,qtPackageRef:{...qt,revision:'c'.repeat(64)}}),false);
 assert.throws(()=>desktopResourceReference({qtPackageRef:{command:'https://invalid.invalid/program'}}));
});

test('restoring a broken selected Qt dependency keeps Native work available without changing its pin', {skip:process.platform!=='win32'||process.arch!=='x64'},async t=>{
 for(const mode of ['missing-package','startup-error']){
  const f=await fixture(t);f.native.selectDesktopResourceRelease(null,0,f.pin);const pointer=path.join(f.root,'data/lan-agent-releases/desktop.json'),before=await fs.readFile(pointer);
  if(mode==='missing-package'){
   const target=path.join(f.managed,f.pin.id,f.pin.version);assert.ok(!path.relative(f.managed,target).startsWith('..'));await fs.rm(target,{recursive:true,force:true});
  }
  let qtLaunches=0;const frames:any[]=[];
  const launch=()=>{const child:any=new EventEmitter();child.pid=101;child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr={resume(){}};child.stdin=new EventEmitter();child.stdin.end=()=>queueMicrotask(()=>child.emit('close',0,null));child.stdin.write=(line:string,callback?:()=>void)=>{const frame=JSON.parse(line);frames.push(frame);const result=frame.action==='capabilities'?{protocolVersion:2,trackingAvailable:false}:frame.action==='windows.list'?{windows:[]}:frame.action==='control.begin'?{visible:true}:{state:'cleared'};queueMicrotask(()=>{child.stdout.emit('data',JSON.stringify({id:frame.id,result})+'\n');callback?.();});return true;};return child;};
  const options={receiptRoot:path.join(f.root,'receipts'),getSettings:()=>DEFAULT_COMPUTER_SETTINGS,resolveDesktopRelease:f.resolve,
   restoreDesktopRelease:async()=>{const s=f.native.desktopResourceSelection();return{revision:s.revision,version:s.version,qtPackageRef:s.qtPackageRef};},
   nativeFactory:({children,timeout,release}:any)=>new NativeComputerClient({children,timeout,qtPresentation:{command:'must-not-launch-builtin-Qt',args:[]},...release.nativeOptions,executable:'controlled-native-fixture',args:[],launch,...(release.nativeOptions?.qtPresentation?{qtPresentation:{...release.nativeOptions.qtPresentation,launch:()=>{qtLaunches++;throw Error('fixture selected Qt cannot start');}}}:{})})};
  const service:any=new ComputerService(options);f.owners.add(service);const status=await service.desktopReleaseStatus();assert.equal(status.state,'degraded');assert.equal(status.release.qtPackageRef.revision,f.pin.revision);assert.equal(status.presentationIssue.code,'COMPUTER_PRESENTATION_UNAVAILABLE');
  const file=path.join(f.root,'healthy.txt');await fs.writeFile(file,'healthy');assert.ok(await service.execute({action:'file.stat',path:file}));
  assert.deepEqual((await service.execute({action:'windows.list'})).windows,[]);
  const control=await service.execute({action:'control.begin',requestId:'healthy-input-'+mode},{sourceId:'fixture'});assert.equal(control.state,'active');assert.equal(frames.find(frame=>frame.action==='control.begin').controlRenderer,'native');
  await assert.rejects(service.execute({action:'annotation.show',requestId:'unavailable-annotation-'+mode,layerId:'layer',objects:[]},{sourceId:'fixture'}),{code:'COMPUTER_ANNOTATION_UNAVAILABLE'});
  assert.equal(frames.some(frame=>frame.action==='annotation.show'),false);assert.equal(qtLaunches,mode==='missing-package'?0:1);assert.deepEqual(await fs.readFile(pointer),before);
 }
});

test('Qt-only slot publication, commit readback, rollback and restart preserve independent owners', {skip:process.platform!=='win32'||process.arch!=='x64',timeout:30000},async t=>{
 t.diagnostic('qt-stage: fixture');
 const f=await fixture(t),clients:Array<any>=[],context={sourceId:'fixture'},previousRefs:any[]=[];let failBeforeCommit=false;
 class Native extends EventEmitter {
  child:any=null;stopping=false;release:any;qtPrepared=false; constructor(release:any){super();this.release=release;}
  async request(action:string){if(this.stopping)throw Error('old worker closed');this.child??={};return action==='capabilities'?{protocolVersion:2,trackingAvailable:false}:{state:'injected',injectedEvents:0};}
  async preparePresentation(){this.qtPrepared=true;}
  async close(){this.stopping=true;this.child=null;this.emit('closed');this.emit('retired');}
 }
 const options={uploadHistoryRoot:path.join(f.root,'uploads'),receiptRoot:path.join(f.root,'receipts'),getSettings:()=>DEFAULT_COMPUTER_SETTINGS,resolveDesktopRelease:(ref:any,previous:any)=>{previousRefs.push(previous);return f.resolve(ref,previous);},
  restoreDesktopRelease:async()=>{const s=f.native.desktopResourceSelection();return {revision:s.revision,version:s.version,...(s.digest?{reference:s.digest}:{}),qtPackageRef:s.qtPackageRef};},
  commitDesktopRelease:async(release:any,revision:number)=>{if(failBeforeCommit)throw Error('synthetic before commit failure');const result=f.native.selectDesktopResourceRelease(release.digest??null,revision,release.qtPackageRef??null);if(result.revision===1)throw Error('synthetic lost commit acknowledgement');return result;},
  nativeFactory:({release}:any)=>{const n=new Native(release);clients.push(n);return n;}};
 t.diagnostic('qt-stage: construct');
 const service:any=new ComputerService(options);f.owners.add(service);const control=service.control,uploads=service.uploads;
 const prepared=await service.prepareDesktopRelease({qtPackageRef:f.pin});t.diagnostic('qt-stage: prepared');const adopted=await service.activateDesktopRelease(prepared,0);t.diagnostic('qt-stage: adopted');assert.equal(adopted.revision,1);assert.equal(clients.length,2);assert.equal(clients[1].qtPrepared,true);assert.equal(service.control,control);assert.equal(service.uploads,uploads);
 const persisted=f.native.desktopResourceSelection();assert.equal(persisted.digest,null);assert.equal(persisted.qtPackageRef?.revision,f.pin.revision);assert.equal(persisted.version,'builtin');
 await service.stop();t.diagnostic('qt-stage: stopped-old');const reopened:any=new ComputerService(options);f.owners.add(reopened);const status=await reopened.desktopReleaseStatus();t.diagnostic('qt-stage: reopened');assert.equal(status.revision,1);assert.deepEqual(status.release.qtPackageRef,persisted.qtPackageRef);assert.equal(clients.at(-1).qtPrepared,true);
 const bad={...f.pin,revision:'d'.repeat(64)};await assert.rejects(reopened.prepareDesktopRelease({qtPackageRef:bad}));assert.equal((await reopened.desktopReleaseStatus()).revision,1);
 assert.equal(previousRefs.at(-1).qtPackageRef.revision,f.pin.revision,'the service passes current Qt identity into the shared resolver');
 const nextPin=await buildDesktopQtPackage({runtimeRoot:f.runtime,outputRoot:path.join(f.root,'candidate-next'),version:'0.1.2'});await f.store.importDirectory(nextPin.outputRoot,()=>{});
 const next=await reopened.prepareDesktopRelease({qtPackageRef:nextPin});failBeforeCommit=true;await assert.rejects(reopened.activateDesktopRelease(next,1),/before commit failure/);failBeforeCommit=false;
 assert.equal((await reopened.desktopReleaseStatus()).release.qtPackageRef.revision,f.pin.revision);assert.equal(clients.at(-1).release.qtPackageRef.revision,f.pin.revision);assert.equal(clients.at(-1).qtPrepared,true,'rollback starts a new original Qt owner, never resets the closed client');
 const reset=await reopened.prepareDesktopRelease({qtPackageRef:null});t.diagnostic('qt-stage: reset prepared');await reopened.activateDesktopRelease(reset,1);t.diagnostic('qt-stage: reset adopted');assert.equal(f.native.desktopResourceSelection().qtPackageRef,undefined);
 assert.equal((await reopened.execute({action:'control.begin',requestId:'new-input'},context)).state,'active');
});
