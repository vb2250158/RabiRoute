import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
const helper=fileURLToPath(new URL('./lib/release-output-lifecycle.ps1',import.meta.url));
const quoted=value=>"'"+value.replaceAll("'","''")+"'";
function run(root, protectedRoots) {
 const env={...process.env};delete env.PSModulePath;
 return spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',`$ErrorActionPreference='Stop'; . ${quoted(helper)}; Reset-ReleasePayloadOutput -OutputRoot ${quoted(root)} -ProtectedRoots @(${protectedRoots.map(quoted).join(',')}) -Version 'fixture'`],{encoding:'utf8',windowsHide:true,env});
}
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'rabi-release-output-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function write(root,file,value){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);return target;}
test('release cleanup preserves newly built nested runtimes and unrelated output while snapshotting prior artifacts', {skip:process.platform!=='win32'},t=>{
 const root=fixture(t), desktop=write(root,'runtime-desktop/main.py','new desktop'),host=write(root,'runtime-host/version/Core.dll','new host');
 write(root,'version-payload/old.js','old payload');write(root,'distribution/old.dll','old distribution');write(root,'RabiRoute-fixture-windows-x64-portable.zip','old zip');write(root,'unrelated.keep','keep');
 const result=run(root,[path.dirname(desktop),path.join(root,'runtime-host')]);assert.equal(result.status,0,result.stderr);
 assert.equal(fs.readFileSync(desktop,'utf8'),'new desktop');assert.equal(fs.readFileSync(host,'utf8'),'new host');assert.equal(fs.readFileSync(path.join(root,'unrelated.keep'),'utf8'),'keep');
 assert.equal(fs.existsSync(path.join(root,'version-payload')),false);assert.equal(fs.existsSync(path.join(root,'distribution')),false);
 const backups=fs.readdirSync(path.join(root,'build-backups'));assert.equal(backups.length,1);const backup=path.join(root,'build-backups',backups[0]);
 assert.equal(fs.readFileSync(path.join(backup,'version-payload/old.js'),'utf8'),'old payload');
 assert.equal(fs.readFileSync(path.join(backup,'RabiRoute-fixture-windows-x64-portable.zip'),'utf8'),'old zip');
 const hashes=JSON.parse(fs.readFileSync(path.join(backup,'source-hashes.json'),'utf8').replace(/^\uFEFF/,''));
 const hash=hashes.find(x=>x.path.replaceAll('\\','/')==='version-payload/old.js');assert.equal(hash.sha256.toLowerCase(),createHash('sha256').update('old payload').digest('hex'));
});
test('runtime inside an owned payload is rejected before any backup or deletion', {skip:process.platform!=='win32'},t=>{
 const root=fixture(t), runtime=write(root,'version-payload/runtime/main.py','owned source');write(root,'distribution/old.dll','old distribution');
 const result=run(root,[path.dirname(runtime)]);assert.notEqual(result.status,0);assert.match(result.stderr,/overlaps a runtime source/);
 assert.equal(fs.readFileSync(runtime,'utf8'),'owned source');assert.equal(fs.readFileSync(path.join(root,'distribution/old.dll'),'utf8'),'old distribution');assert.equal(fs.existsSync(path.join(root,'build-backups')),false);
});
