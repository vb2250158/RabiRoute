import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeManifest } from './create-windows-release-manifest.mjs';
const script = fileURLToPath(new URL('./Archive-RabiRouteRolledBackTransaction.ps1', import.meta.url));
const shell = 'powershell.exe';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
function fixture(extraFiles = 0) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rabi-archive-')));
  const install = path.join(root, 'install');
  const owner = path.join(install, '.install-staging', 'a'.repeat(32));
  const version = path.join(install, 'versions', 'draft');
  for (const file of ['RabiRouteHost.Core.dll','node.exe','dist/manager.js','ribiwebgui/dist/index.html','desktop-runtime/main.py','desktop-runtime/python/python.exe']) {
    const target = path.join(version, file); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, `fixture:${file}`);
  }
  for (let index = 0; index < extraFiles; index++) fs.writeFileSync(path.join(version, `fixture-${index}.bin`), 'fixture');
  const manifest = writeManifest(version, '9.9.9');
  fs.renameSync(version, path.join(install, 'versions', manifest.releaseId));
  const pointer = releaseId => ({schemaVersion:1,appId:'io.rabiroute.windows',releaseId,versionPath:`versions/${releaseId}`,payloadSha256:manifest.payloadSha256});
  const current = path.join(install,'current.json'); save(current, pointer(manifest.releaseId));
  save(path.join(owner,'backup/current.json'),pointer('8.8.8-backup'));
  const candidate = path.join(owner,'candidate');
  const candidateVersion = path.join(candidate,'versions','draft');
  fs.cpSync(path.join(install,'versions',manifest.releaseId),candidateVersion,{recursive:true});
  fs.unlinkSync(path.join(candidateVersion,'release-manifest.json'));
  // Keep the staged candidate small even in the current-release progress fixture.
  for(let index=0;index<extraFiles;index++) fs.unlinkSync(path.join(candidateVersion,`fixture-${index}.bin`));
  const candidateManifest=writeManifest(candidateVersion,'8.8.9');
  const stagedVersion=path.join(candidate,'versions',candidateManifest.releaseId);
  fs.renameSync(candidateVersion,stagedVersion);
  save(path.join(candidate,'current.json'),{...pointer(candidateManifest.releaseId),payloadSha256:candidateManifest.payloadSha256});
  fs.writeFileSync(path.join(candidate,'RabiRouteHost.exe'),'fixture-candidate-bootstrap');
  fs.writeFileSync(path.join(install,'RabiRouteHost.exe'),'fixture-bootstrap');
  fs.writeFileSync(path.join(owner,'backup/RabiRouteHost.exe'),'fixture-bootstrap');
  const taskRoot = path.join(owner,'backup/legacy-wearable-task');
  save(path.join(taskRoot,'task-backup.json'),{schemaVersion:1,taskName:'RabiLinkWearableHealthCompanion',taskPath:'\\',wasPresent:false,wasRunning:false});
  const snapshotRoot = path.join(owner,'backup/autostart');
  save(path.join(snapshotRoot,'snapshot.json'),{schemaVersion:1,installRoot:install,entries:Object.fromEntries(['settings','startup','legacyStartup'].map(name=>[name,{existed:false,backupName:`${name}.bin`,sha256:''}]))});
  const journal = {schemaVersion:1,appId:'io.rabiroute.windows',state:'rolled-back',releaseId:candidateManifest.releaseId,transactionRoot:owner,destinationVersion:path.join(install,'versions',candidateManifest.releaseId),versionMoveState:'not-started',versionCommitted:false,hadPointer:true,hadBootstrap:true,quarantineRoot:path.join(install,'.rabiroute-quarantine','a'.repeat(32),'legacy-runtime'),quarantineMoves:[],legacyTaskMigrationState:'restored',legacyTaskBackupRoot:taskRoot,autostartState:'captured',autostartSnapshotRoot:snapshotRoot,error:'Fenced Host stop failed with ExitCode=1.'};
  const journalPath = path.join(install,'.rabiroute-install-transaction.json'); save(journalPath,journal);
  const original = fs.readFileSync(journalPath);
  const journalHash = hash(original);
  const args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-InstallRoot',install,'-ExpectedCurrentReleaseId',manifest.releaseId,'-ExpectedJournalSha256',journalHash,'-ExpectedCurrentPointerSha256',hash(fs.readFileSync(current))];
  return {root,install,owner,candidate,stagedVersion,candidateManifest,journal,journalPath,original,journalHash,current,args,manifest, archive:path.join(owner,`journal-${journalHash}.original.json`),removed:path.join(owner,`journal-${journalHash}.removed.json`)};
}
function run(f, extra=['-Archive']) { return spawnSync(shell,[...f.args,...extra],{encoding:'utf8',timeout:60000}); }
function tree(root) {
  return fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const file=path.join(e.parentPath ?? e.path,e.name);return [path.relative(root,file),hash(fs.readFileSync(file))];}).sort((a,b)=>a[0].localeCompare(b[0]));
}
const windows = {skip:process.platform!=='win32'};
test('read-only admission, archive, durable retry and all unrelated evidence preserved',windows,()=>{
 const f=fixture(); try {
  const before=tree(f.install); let r=run(f,[]); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).state,'eligible-read-only'); assert.deepEqual(tree(f.install),before);
  r=run(f); assert.equal(r.status,0,r.stderr); assert.ok(!fs.existsSync(f.journalPath)); assert.deepEqual(fs.readFileSync(f.archive),f.original); assert.deepEqual(fs.readFileSync(f.removed),f.original);
  for(const [file,digest] of before.filter(([p])=>p!==path.basename(f.journalPath))) assert.equal(hash(fs.readFileSync(path.join(f.install,file))),digest,file);
  r=run(f); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).state,'already-archived');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('rejects wrong hashes/releases, unsupported states, escape, missing backup and archive conflict without writes',windows,()=>{
 for(const mode of ['hash','pointerHash','release','state','boolean','task','escape','backup','archive','payload','bootstrap','candidate','quarantine','autostart','error','reparse','taskPresent','startupPresent','destination','quarantineDir','manifestEscape']) {
  const f=fixture(); try {
   if(mode==='hash') f.args[f.args.indexOf('-ExpectedJournalSha256')+1]='0'.repeat(64);
   else if(mode==='pointerHash') f.args[f.args.indexOf('-ExpectedCurrentPointerSha256')+1]='0'.repeat(64);
   else if(mode==='release') f.args[f.args.indexOf('-ExpectedCurrentReleaseId')+1]='wrong-release';
   else if(mode==='archive') fs.writeFileSync(f.archive,'conflict');
   else if(mode==='backup') fs.unlinkSync(path.join(f.owner,'backup/current.json'));
   else if(mode==='payload') fs.appendFileSync(path.join(f.install,'versions',f.manifest.releaseId,'node.exe'),'drift');
   else if(mode==='bootstrap') fs.appendFileSync(path.join(f.install,'RabiRouteHost.exe'),'drift');
   else if(mode==='candidate') fs.mkdirSync(path.join(f.owner,'candidate/versions/8.8.9-candidate'),{recursive:true});
   else if(mode==='reparse') { const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.owner,'junction'),'junction'); }
   else if(mode==='taskPresent') { const file=path.join(f.journal.legacyTaskBackupRoot,'task-backup.json');const value=JSON.parse(fs.readFileSync(file));value.wasPresent=true;save(file,value); }
   else if(mode==='startupPresent') { const file=path.join(f.journal.autostartSnapshotRoot,'snapshot.json');const value=JSON.parse(fs.readFileSync(file));value.entries.startup.existed=true;save(file,value); }
   else if(mode==='destination') fs.mkdirSync(f.journal.destinationVersion,{recursive:true});
   else if(mode==='quarantineDir') fs.mkdirSync(f.journal.quarantineRoot,{recursive:true});
   else if(mode==='manifestEscape') { const file=path.join(f.install,'versions',f.manifest.releaseId,'release-manifest.json');const value=JSON.parse(fs.readFileSync(file));value.files[0].path='../outside';save(file,value); }
   else {
    if(mode==='state') f.journal.versionMoveState='planned';
    if(mode==='boolean') f.journal.versionCommitted='false';
    if(mode==='task') f.journal.legacyTaskMigrationState='removed';
    if(mode==='escape') f.journal.autostartSnapshotRoot=path.join(f.root,'outside');
    if(mode==='quarantine') f.journal.quarantineMoves=[{}];
    if(mode==='autostart') f.journal.autostartState='applied';
    if(mode==='error') f.journal.error='unknown';
    save(f.journalPath,f.journal); f.args[f.args.indexOf('-ExpectedJournalSha256')+1]=hash(fs.readFileSync(f.journalPath));
   }
   const before=tree(f.install); const r=run(f); assert.notEqual(r.status,0,mode); assert.deepEqual(tree(f.install),before,mode);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
});
test('staged candidate corruption, layout, identity and reparse fail without any mutation',windows,()=>{
 for(const mode of ['hash','size','extraVersion','identity','escape','extraFile','extraRoot','missingBootstrap','emptyBootstrap','missingVersion','reparse','rootReparse','versionsReparse','canonical','required']) {
  const f=fixture();try{
   const manifestPath=path.join(f.stagedVersion,'release-manifest.json');
   if(mode==='hash') fs.writeFileSync(path.join(f.stagedVersion,'node.exe'),'x'.repeat(fs.statSync(path.join(f.stagedVersion,'node.exe')).size));
   if(mode==='size') fs.appendFileSync(path.join(f.stagedVersion,'node.exe'),'drift');
   if(mode==='extraVersion') fs.mkdirSync(path.join(f.candidate,'versions','foreign'));
   if(mode==='identity') {const p=JSON.parse(fs.readFileSync(path.join(f.candidate,'current.json')));p.releaseId='foreign';save(path.join(f.candidate,'current.json'),p);}
   if(mode==='escape') {const m=JSON.parse(fs.readFileSync(manifestPath));m.files[0].path='../outside';save(manifestPath,m);}
   if(mode==='extraFile') fs.writeFileSync(path.join(f.stagedVersion,'foreign.bin'),'foreign');
   if(mode==='extraRoot') fs.writeFileSync(path.join(f.candidate,'foreign.bin'),'foreign');
   if(mode==='missingBootstrap') fs.unlinkSync(path.join(f.candidate,'RabiRouteHost.exe'));
   if(mode==='emptyBootstrap') fs.writeFileSync(path.join(f.candidate,'RabiRouteHost.exe'),'');
   if(mode==='missingVersion') fs.rmSync(f.stagedVersion,{recursive:true});
   if(mode==='reparse') {const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(f.stagedVersion,'junction'),'junction');}
   if(mode==='rootReparse' || mode==='versionsReparse') {const target=mode==='rootReparse'?f.candidate:path.join(f.candidate,'versions');const outside=path.join(f.root,'outside');fs.renameSync(target,outside);fs.symlinkSync(outside,target,'junction');}
   if(mode==='canonical') {const m=JSON.parse(fs.readFileSync(manifestPath));m.packageVersion='forged';save(manifestPath,m);}
   if(mode==='required') {const m=JSON.parse(fs.readFileSync(manifestPath));m.files=m.files.filter(e=>e.path!=='node.exe');save(manifestPath,m);fs.unlinkSync(path.join(f.stagedVersion,'node.exe'));}
   const before=tree(f.install);const r=run(f);assert.notEqual(r.status,0,mode);assert.deepEqual(tree(f.install),before,mode);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
});
test('retries after durable original publish and interrupted temporary write without overwrite',windows,()=>{
 const f=fixture();try{
  fs.writeFileSync(f.archive,f.original);fs.writeFileSync(`${f.archive}.interrupted.pending`,'partial');
  const r=run(f);assert.equal(r.status,0,r.stderr);assert.equal(fs.readFileSync(`${f.archive}.interrupted.pending`,'utf8'),'partial');
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('CAS rejects pointer/journal changes across lock and durable-archive boundaries',windows,()=>{
 for(const [boundary,target] of [['lock','pointer'],['lock','journal'],['commit','pointer'],['commit','journal']]) {
  const f=fixture();try {
   // Instrument only a temporary copy; production exposes no fault-injection bypass.
   const copy=path.join(f.root,'instrumented.ps1');
   let source=fs.readFileSync(script,'utf8');
   const variable=target==='pointer'?'$pointerPath':'$journalPath';
   const mutate=`[IO.File]::AppendAllText(${variable},' ')`;
   if(boundary==='lock') source=source.replace('    Assert-Cas\n    $owner =',`    ${mutate}\n    Assert-Cas\n    $owner =`);
   else source=source.replace('        Assert-Cas\n        # Same-volume',`        ${mutate}\n        Assert-Cas\n        # Same-volume`);
   fs.writeFileSync(copy,source);f.args[f.args.indexOf('-File')+1]=copy;
   const r=run(f);assert.notEqual(r.status,0,`${boundary}/${target}`);assert.match(r.stderr,/CAS mismatch/);assert.ok(fs.existsSync(f.journalPath));assert.ok(!fs.existsSync(f.removed));
   if(boundary==='commit') assert.deepEqual(fs.readFileSync(f.archive),f.original);
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
 }
});
test('Verbose reports stages and every 1000 hashes while success stream stays JSON',windows,()=>{
 const f=fixture(995);try{
  const before=tree(f.install);
  const wrapper=path.join(f.root,'verbose.ps1');const progress=path.join(f.root,'verbose.log');
  const quote=value=>`'${value.replaceAll("'","''")}'`;
  const values=f.args.slice(f.args.indexOf('-InstallRoot'));
  const parameters=[];for(let index=0;index<values.length;index+=2) parameters.push(`${values[index]} ${quote(values[index+1])}`);
  const invocation=`& ${quote(script)} ${parameters.join(' ')}`;
  fs.writeFileSync(wrapper,`$ErrorActionPreference='Stop'\n${invocation} -Verbose 4> ${quote(progress)}\n`);
  const r=spawnSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper],{encoding:'utf8',timeout:180000});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).state,'eligible-read-only');
  const messages=fs.readFileSync(progress,'utf16le');
  for(const stage of ['transaction-tree','release-tree','manifest-hash','extra-files','cas']) {
   assert.match(messages,new RegExp(`stage=${stage} state=starting`));assert.match(messages,new RegExp(`stage=${stage} state=complete`));
  }
  assert.match(messages,/state=progress processed=1000 total=1001/);assert.equal((messages.match(/state=progress/g)??[]).length,1);
  assert.match(messages,/state=complete processed=1001 total=1001/);assert.deepEqual(tree(f.install),before);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});
test('shared installer mutex prevents archive',windows,async()=>{
 const f=fixture(); const mutexHash=hash(f.install.toLowerCase());
 const command=`$m=[Threading.Mutex]::new($false,'Local\\RabiRoute.Install.${mutexHash.slice(0,32)}');$null=$m.WaitOne();[Console]::Out.WriteLine('locked');[Console]::Out.Flush();[Console]::ReadLine() | Out-Null;$m.ReleaseMutex();$m.Dispose()`;
 const child=spawn(shell,['-NoProfile','-NonInteractive','-Command',command],{stdio:['pipe','pipe','pipe']});
 try { await once(child.stdout,'data');const before=tree(f.install);const r=run(f);assert.notEqual(r.status,0);assert.match(r.stderr,/mutex/);assert.deepEqual(tree(f.install),before); }
 finally {child.stdin.end('\n');await once(child,'exit');fs.rmSync(f.root,{recursive:true,force:true});}
});
