import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { __test } from '../rabi-agent.mjs';

test('signed payload identity changes for same-version changed bytes and stays stable unchanged', () => {
  const release = {version:'0.2.0',platform:'node',minNodeVersion:'22',files:[{path:'rabi-agent.mjs',sha256:'a'.repeat(64),size:3,downloadUrl:'/api/lan-agent/releases/0.2.0/node/rabi-agent.mjs'}]};
  assert.equal(__test.releaseDigest(release), __test.releaseDigest(structuredClone(release)));
  const next = structuredClone(release); next.files[0].sha256 = 'b'.repeat(64);
  assert.notEqual(__test.releaseDigest(release), __test.releaseDigest(next));
});

test('same version installs immutable digest directories and validates reuse', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rabi-release-install-'));
 const original=globalThis.fetch;
 try {
  let bytes=Buffer.from('old'); let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(bytes);};
  const make=()=>({version:'0.2.0',platform:'node',minNodeVersion:'22',files:[{path:'rabi-agent.mjs',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),downloadUrl:'/api/lan-agent/releases/0.2.0/node/rabi-agent.mjs'}]});
  const config={managerUrl:'http://manager.invalid',nodeCredential:'fixture'};
  const configPath=path.join(root,'config.json');
  const release=make(); const old=await __test.installRelease(config,release,configPath);
  assert.equal(await __test.installRelease(config,release,configPath),old); assert.equal(calls,1);
  bytes=Buffer.from('new');const next=await __test.installRelease(config,make(),configPath);
  assert.notEqual(old,next);assert.equal(fs.readFileSync(old,'utf8'),'old');
  fs.writeFileSync(old,'bad');await assert.rejects(__test.installRelease(config,release,configPath),/integrity/);
 } finally {globalThis.fetch=original;fs.rmSync(root,{recursive:true,force:true});}
});

test('already-loaded stable hook follows atomic pointer and ignores an unready candidate', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rabi-release-shim-'));
 try {
  const config=path.join(root,'config.json');
  for(const name of ['old','candidate']) {
   fs.mkdirSync(path.join(root,name,'lib'),{recursive:true});
   fs.writeFileSync(path.join(root,name,'rabi-agent.mjs'),'');
   fs.writeFileSync(path.join(root,name,'lib','instance-hook.mjs'),`export async function requestInstanceHook(){return ${JSON.stringify(name)};}`);
  }
  __test.writeCurrentRelease(config,path.join(root,'old','rabi-agent.mjs'),'a'.repeat(64));
  __test.writeLauncher(config);
  const hook=await import(pathToFileURL(path.join(root,'hook-client.mjs')).href);
  assert.equal(await hook.requestInstanceHook({},config),'old');
  // Merely installing/starting a candidate cannot change the committed pointer or hook.
  assert.equal(await hook.requestInstanceHook({},config),'old');
  __test.writeCurrentRelease(config,path.join(root,'candidate','rabi-agent.mjs'),'b'.repeat(64));
  assert.equal(await hook.requestInstanceHook({},config),'candidate');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'current-release.json'))).digest,'b'.repeat(64));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
