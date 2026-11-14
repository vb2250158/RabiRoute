import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import{createHash}from'node:crypto';
import{collectReleaseAssetPaths}from'../lib/release-assets.mjs';
test('signed inventory carries exactly the builder-declared tracking closure and rejects a changed runtime file',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'rabi-tracking-inventory-'));
 try{await mkdir(path.join(root,'dist/native'),{recursive:true});await mkdir(path.join(root,'desktop'),{recursive:true});
 await writeFile(path.join(root,'desktop/computer-native.cs'),'fixture single source');
 const spec=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../desktop/tracking/asset-spec.json',import.meta.url),'utf8'));
 await mkdir(path.join(root,'desktop/tracking'),{recursive:true});const specBytes=Buffer.from(JSON.stringify(spec));await writeFile(path.join(root,'desktop/tracking/asset-spec.json'),specBytes);
 const names=[...spec.managedFiles,...spec.nativeFiles.map(file=>file.path),...spec.notices.map(file=>file.path)];
 const filesMeta=[];for(const name of names){const bytes=Buffer.from('fixture-'+name);await writeFile(path.join(root,'dist/native',name),bytes);filesMeta.push({path:name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 await writeFile(path.join(root,'dist/native/not-published.exe'),'builder scratch');
 const manifest={schemaVersion:1,architecture:'win-x64',inputs:spec.inputs.map(name=>({path:name,sha256:createHash('sha256').update(name==='desktop/tracking/asset-spec.json'?specBytes:Buffer.from('fixture-source')).digest('hex')})),files:filesMeta};
 const manifestFile=path.join(root,'dist/native/computer-tracking-assets.json');await writeFile(manifestFile,JSON.stringify(manifest));
 const files=collectReleaseAssetPaths(root);assert.ok(files.includes('desktop/computer-native.cs'));assert.ok(files.includes('dist/native/RabiAgent.Computer.Tracking.dll'));assert.ok(files.includes('dist/native/computer-tracking-assets.json'));assert.ok(!files.includes('dist/native/not-published.exe'));
 await writeFile(manifestFile,JSON.stringify({...manifest,inputs:[],files:[]}));assert.throws(()=>collectReleaseAssetPaths(root),/incomplete|duplicated/);await writeFile(manifestFile,JSON.stringify(manifest));
 await writeFile(path.join(root,'dist/native/RabiAgent.Computer.Tracking.dll'),'changed');assert.throws(()=>collectReleaseAssetPaths(root),/closure differs/);
 }finally{await rm(root,{recursive:true,force:true});}
});
