import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { materializeLocalDependencies, assertPackageEntries } from './materialize-local-dependencies.mjs';

test('local file dependency includes npm files and every runtime/types export even when tracked payload is stale', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rabi-local-package-test-')),repo=path.join(root,'repo'),payload=path.join(root,'payload');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(repo,'contracts/sdk');fs.mkdirSync(source,{recursive:true});
  fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({dependencies:{'@fixture/sdk':'file:contracts/sdk'}}));
  const pkg={name:'@fixture/sdk',version:'1.0.0',type:'module',types:'./index.d.ts',exports:{'.':{types:'./index.d.ts',import:'./index.mjs'},'./publication':{types:'./publication.d.ts',import:'./publication.mjs'}},files:['index.mjs','index.d.ts','publication.mjs','publication.d.ts','api-operation-contract.d.ts']};
  const contents={'package.json':JSON.stringify(pkg),'index.mjs':'export const ready=true;','index.d.ts':'export const ready: true;','publication.mjs':'export const publication=true;','publication.d.ts':'export const publication: true;','api-operation-contract.d.ts':'export type Contract = string;'};
  for(const [file,text]of Object.entries(contents))fs.writeFileSync(path.join(source,file),text);
  const stale=path.join(payload,'contracts/sdk');fs.mkdirSync(stale,{recursive:true});fs.writeFileSync(path.join(stale,'package.json'),JSON.stringify(pkg));
  fs.mkdirSync(path.join(payload,'node_modules/@fixture'),{recursive:true});fs.symlinkSync(stale,path.join(payload,'node_modules/@fixture/sdk'),process.platform==='win32'?'junction':'dir');
  const result=materializeLocalDependencies({repo,payload,packList:()=>Object.keys(contents)});
  assert.equal(result.length,1);assert.equal(result[0].files.length,6);
  for(const location of ['contracts/sdk','node_modules/@fixture/sdk']){
    const inspected=assertPackageEntries(path.join(payload,location));assert.deepEqual(inspected.files,result[0].files);assert.equal(fs.lstatSync(path.join(payload,location)).isSymbolicLink(),false);
    for(const [file,text]of Object.entries(contents))assert.equal(fs.readFileSync(path.join(payload,location,file),'utf8'),text);
  }
  assert.throws(()=>materializeLocalDependencies({repo,payload,packList:()=>Object.keys(contents).filter(file=>file!=='publication.mjs')}),/entry is missing/);
  assert.equal(fs.readFileSync(path.join(payload,'node_modules/@fixture/sdk/publication.mjs'),'utf8'),contents['publication.mjs']);
});

test('npm package listing includes the actual SDK publication and type contract', () => {
  const repo=path.resolve(new URL('../../',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'rabi-sdk-pack-test-'));
  try {
    const records=materializeLocalDependencies({repo,payload:path.join(root,'payload')});
    const sdk=records.find(item=>item.name==='@rabiroute/plugin-sdk');assert.ok(sdk);
    for(const file of ['publication.mjs','publication.d.ts','api-operation-contract.d.ts'])assert.ok(sdk.files.some(item=>item.path===file));
    assert.ok(sdk.entryTargets.includes('./publication.mjs'));assert.ok(sdk.entryTargets.includes('./publication.d.ts'));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
