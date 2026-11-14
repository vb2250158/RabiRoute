import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { posixOwnerLeaseRuntime, requirePosixOwnerProtocol } from '../lib/posix-owner-lease.mjs';

const supported = ['linux','darwin'].includes(process.platform);
const moduleUrl = new URL('../lib/posix-owner-lease.mjs',import.meta.url).href;
const entry = path.resolve(import.meta.dirname,'../rabi-agent.mjs');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rabi-posix-lease-')));
  fs.chmodSync(root,0o700);
  const config=path.join(root,'config.json');fs.writeFileSync(config,'{}',{mode:0o600});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,config};
}
function childExit(child) { return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}); }

test('POSIX config and launcher leases reject concurrent owners and survive stale diagnostic bytes', {skip:!supported}, async t=>{
  const f=fixture(t),runtime=posixOwnerLeaseRuntime(f.config),original=runtime.acquire(f.config,'launcher');
  const inode=fs.statSync(original.filename,{bigint:true}).ino;
  const source=path.join(f.root,'contender.mjs');
  fs.writeFileSync(source,`import {posixOwnerLeaseRuntime} from ${JSON.stringify(moduleUrl)};try{const h=posixOwnerLeaseRuntime(${JSON.stringify(f.config)}).acquire(${JSON.stringify(f.config)},'launcher');h.release();process.exitCode=0}catch(e){process.exitCode=e.code==='RABI_AGENT_LEASE_BUSY'?17:1}`);
  const run=()=>spawn(process.execPath,[source],{stdio:'ignore'});
  assert.equal(await childExit(run()),17);
  fs.writeFileSync(path.join(f.root,'launcher-control-stale.json'),'untrusted cache');
  original.release();original.release();assert.equal(await childExit(run()),0);
  assert.equal(fs.statSync(original.filename,{bigint:true}).ino,inode);
  const writer=runtime.acquire(f.config,'config');assert.throws(()=>runtime.acquire(f.config,'config'),{code:'RABI_AGENT_LEASE_BUSY'});
  writer.release();
});

test('POSIX process death releases the original flock inode without unlinking it', {skip:!supported}, async t=>{
  const f=fixture(t),source=path.join(f.root,'owner.mjs');
  fs.writeFileSync(source,`import {posixOwnerLeaseRuntime} from ${JSON.stringify(moduleUrl)};const h=posixOwnerLeaseRuntime(${JSON.stringify(f.config)}).acquire(${JSON.stringify(f.config)},'launcher');process.send({file:h.filename});setInterval(()=>{},1000);`);
  const owner=spawn(process.execPath,[source],{stdio:['ignore','ignore','ignore','ipc']});const closed=childExit(owner);
  t.after(async()=>{if(owner.exitCode===null&&owner.signalCode===null)owner.kill('SIGKILL');await closed;});
  const ready=await new Promise((resolve,reject)=>{owner.once('message',resolve);owner.once('error',reject);});
  const inode=fs.statSync(ready.file,{bigint:true}).ino;
  assert.throws(()=>posixOwnerLeaseRuntime(f.config).acquire(f.config,'launcher'),{code:'RABI_AGENT_LEASE_BUSY'});
  owner.kill('SIGKILL');await closed;
  const next=posixOwnerLeaseRuntime(f.config).acquire(f.config,'launcher');
  assert.equal(fs.statSync(next.filename,{bigint:true}).ino,inode);next.release();
});

test('POSIX lease identity is not compressed into the legacy 16384-slot namespace', {skip:!supported}, t=>{
  const f=fixture(t),seen=new Map();let pair;
  for(let i=0;i<10000;i++){
    const file=path.join(f.root,`config-${i}.json`),hash=createHash('sha256').update(file).digest('hex');
    const slot=Number.parseInt(hash.slice(0,8),16)%16384;
    if(seen.has(slot)){pair=[seen.get(slot),file];break;}seen.set(slot,file);
  }
  assert.ok(pair);for(const file of pair)fs.writeFileSync(file,'{}',{mode:0o600});
  const a=posixOwnerLeaseRuntime(pair[0]).acquire(pair[0],'config'),b=posixOwnerLeaseRuntime(pair[1]).acquire(pair[1],'config');
  assert.notEqual(a.filename,b.filename);a.release();b.release();
});

test('POSIX legacy TCP listeners cannot occupy the new config or launcher ownership boundary', {skip:!supported}, async t=>{
  const f=fixture(t),hash=createHash('sha256').update(f.config).digest('hex'),slot=Number.parseInt(hash.slice(0,8),16)%16384;
  const servers=[];
  t.after(async()=>{await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));});
  for(const base of [16384,32768,49152]) {
    const server=net.createServer(socket=>socket.destroy());
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:base+slot},resolve);});servers.push(server);
  }
  const runtime=posixOwnerLeaseRuntime(f.config),a=runtime.acquire(f.config,'launcher'),b=runtime.acquire(f.config,'config');
  assert.equal(servers.every(server=>server.listening),true);a.release();b.release();
});

test('POSIX lease rejects symlinks, hardlinks and nonprivate regular files', {skip:!supported}, t=>{
  const f=fixture(t),runtime=posixOwnerLeaseRuntime(f.config),first=runtime.acquire(f.config,'config'),filename=first.filename;
  first.release();fs.chmodSync(filename,0o644);assert.throws(()=>runtime.acquire(f.config,'config'),/0600/);
  fs.chmodSync(filename,0o600);const other=path.join(f.root,'linked');fs.linkSync(filename,other);
  assert.throws(()=>runtime.acquire(f.config,'config'),/singly linked/);fs.unlinkSync(other);
  const moved=path.join(f.root,'old-lock');fs.renameSync(filename,moved);fs.symlinkSync(moved,filename);
  assert.throws(()=>runtime.acquire(f.config,'config'));
});

test('POSIX legacy protocol is a rejection boundary, never an owner-absence receipt', async t=>{
  const f=fixture(t),launcher=path.join(f.root,'rabi-agent-launcher.mjs'),pointer=path.join(f.root,'current-release.json');
  fs.writeFileSync(launcher,'// original legacy owner');fs.writeFileSync(pointer,'{"entrypoint":"old.mjs"}');
  const source=path.join(f.root,'refuse-legacy.mjs');
  fs.writeFileSync(source,`Object.defineProperty(process,'platform',{value:'linux'});const {requirePosixOwnerProtocol}=await import(${JSON.stringify(moduleUrl)});try{requirePosixOwnerProtocol(${JSON.stringify(f.config)});process.exitCode=1}catch(e){if(!/legacy TCP owner/.test(e.message))throw e;process.exitCode=0}`);
  assert.equal(await childExit(spawn(process.execPath,[source],{stdio:'inherit'})),0);
  assert.equal(fs.readFileSync(launcher,'utf8'),'// original legacy owner');assert.equal(fs.readFileSync(pointer,'utf8'),'{"entrypoint":"old.mjs"}');
});

for(const scenario of ['current','old-parent','wrong-nonce','wrong-owner'])test(`POSIX parent IPC protocol: ${scenario}`, async t=>{
  const f=fixture(t),source=path.join(f.root,'parent-check.mjs');
  fs.writeFileSync(source,`Object.defineProperty(process,'platform',{value:'linux'});const {requirePosixParentOwner}=await import(${JSON.stringify(moduleUrl)});try{await requirePosixParentOwner(${JSON.stringify(f.config)},150);process.exitCode=0}catch(e){process.stderr.write(e.message+'\\n');process.exitCode=17}finally{process.disconnect()}`);
  const child=spawn(process.execPath,[source],{stdio:['ignore','ignore','pipe','ipc']});let output='';child.stderr.on('data',bytes=>output+=bytes);
  child.on('message',message=>{
    assert.equal(message.type,'posixOwnerChallenge');assert.match(message.nonce,/^[a-f0-9]{64}$/);
    if(scenario==='old-parent')return;
    child.send({type:'posixOwnerProtocol',protocol:2,nonce:scenario==='wrong-nonce'?'0'.repeat(64):message.nonce,
      configHash:scenario==='wrong-owner'?'wrong-owner':message.configHash});
  });
  assert.equal(await childExit(child),scenario==='current'?0:17,output);
});

test('actual v2 update candidate rejects an old IPC parent before dependencies, preparation or pointer changes', async t=>{
  const f=fixture(t),preload=path.join(f.root,'platform.mjs'),npm=path.join(f.root,'npm-cli.js');
  const marker=path.join(f.root,'dependency-attempt');
  fs.writeFileSync(preload,"Object.defineProperty(process,'platform',{value:'linux'});");
  fs.writeFileSync(npm,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');process.exit(1);`);
  const config=JSON.stringify({schemaVersion:1,nodeId:'fixture',nodeCredential:'private-fixture',managerUrl:'http://fixture.invalid',
    releasePublicKeySha256:'a'.repeat(64),defaultWorkspace:f.root,allowedWorkspaces:[f.root],agents:[{sessionId:'legacy-binding'}],autoUpdate:false,
    timeoutOverridesCache:{'agent.launcher.handshake':100}});
  const pointer='{"entrypoint":"original-v1.mjs","digest":"original"}',launcher='// original legacy launcher';
  fs.writeFileSync(f.config,config);fs.writeFileSync(path.join(f.root,'current-release.json'),pointer);
  fs.writeFileSync(path.join(f.root,'rabi-agent-launcher.mjs'),launcher);
  const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,entry,'--run','--config',f.config],{
    stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,RABI_AGENT_SUPERVISED:'1',RABI_AGENT_UPDATE_CANDIDATE:'1',npm_execpath:npm}});
  let output='';const messages=[];child.stderr.on('data',bytes=>output+=bytes);child.on('message',message=>messages.push(message));
  assert.equal(await childExit(child),1,output);
  assert.match(output,/Legacy POSIX launcher cannot adopt a v2 worker online/);
  assert.deepEqual(messages.map(message=>message.type),['posixOwnerChallenge']);
  assert.equal(fs.existsSync(marker),false);assert.equal(fs.existsSync(path.join(f.root,'.rabi-agent-native')),false);
  assert.equal(fs.readFileSync(f.config,'utf8'),config);
  assert.equal(fs.readFileSync(path.join(f.root,'current-release.json'),'utf8'),pointer);
  assert.equal(fs.readFileSync(path.join(f.root,'rabi-agent-launcher.mjs'),'utf8'),launcher);
});

for (const protectedWorker of [false, true]) test('POSIX shared lease retains original worker until actual exit; protected=' + protectedWorker,
  {skip:!supported || (protectedWorker && process.platform !== 'linux')}, async t => {
  const f=fixture(t),ownerFile=path.join(f.root,'inheriting-owner.mjs'),workerFile=path.join(f.root,'inheriting-worker.mjs');
  const hash=createHash('sha256').update(f.config).digest('hex');
  fs.writeFileSync(workerFile,`import fs from 'node:fs';import {spawnSync} from 'node:child_process';
import {requirePosixParentOwner,protectPosixWorkerLease} from ${JSON.stringify(moduleUrl)};
const parent=process.ppid;
if(${protectedWorker}) {
 await requirePosixParentOwner(${JSON.stringify(f.config)},1000);
 protectPosixWorkerLease(${JSON.stringify(f.config)},parent);
 const inode=fs.fstatSync(4,{bigint:true}).ino.toString();
 const result=spawnSync(process.execPath,['-e',"try{const s=require('node:fs').fstatSync(4,{bigint:true});process.exit(s.ino.toString()===process.argv[1]?9:0)}catch{process.exit(0)}",inode]);
 if(result.status!==0)throw Error('Lease FD leaked to external tool');
}
process.send({type:'ready',pid:process.pid});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
`);
  fs.writeFileSync(ownerFile,`import {spawn} from 'node:child_process';import {posixOwnerLeaseRuntime} from ${JSON.stringify(moduleUrl)};
const lease=posixOwnerLeaseRuntime(${JSON.stringify(f.config)}).acquire(${JSON.stringify(f.config)},'launcher');
const worker=spawn(process.execPath,[${JSON.stringify(workerFile)}],{stdio:['ignore','ignore','inherit','ipc',lease.inheritedDescriptor()]});
worker.on('message',m=>{if(m.type==='posixOwnerChallenge')worker.send({type:'posixOwnerProtocol',protocol:2,nonce:m.nonce,configHash:${JSON.stringify(hash)}});else process.send(m)});
setInterval(()=>{},1000);
`);
  const owner=spawn(process.execPath,[ownerFile],{stdio:['ignore','ignore','inherit','ipc']}),closed=childExit(owner);
  let workerPid;
  t.after(async()=>{if(owner.exitCode===null&&owner.signalCode===null)owner.kill('SIGKILL');await closed;if(workerPid){try{process.kill(workerPid,'SIGKILL')}catch{}}});
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker guard readiness timed out')),5000);owner.once('message',m=>{clearTimeout(timer);resolve(m)});owner.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture owner exited before worker readiness'))});});
  workerPid=ready.pid;assert.equal(ready.type,'ready');
  const runtime=posixOwnerLeaseRuntime(f.config);
  assert.throws(()=>runtime.acquire(f.config,'launcher'),{code:'RABI_AGENT_LEASE_BUSY'});
  owner.kill('SIGKILL');await closed;
  if(!protectedWorker){assert.throws(()=>runtime.acquire(f.config,'launcher'),{code:'RABI_AGENT_LEASE_BUSY'});process.kill(workerPid,'SIGKILL');}
  const deadline=Date.now()+5000;let next;
  while(Date.now()<deadline){try{next=runtime.acquire(f.config,'launcher');break}catch(e){if(e.code!=='RABI_AGENT_LEASE_BUSY')throw e;await new Promise(r=>setTimeout(r,20));}}
  assert.ok(next,'Original worker must exit before the replacement lease can be acquired');next.release();
});

test('POSIX worker rejects a separately opened descriptor of the same locked inode', {skip:!supported}, async t=>{
  const f=fixture(t),runtime=posixOwnerLeaseRuntime(f.config),lease=runtime.acquire(f.config,'launcher');
  const wrong=fs.openSync(lease.filename,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW),source=path.join(f.root,'wrong-description.mjs');
  t.after(()=>{fs.closeSync(wrong);lease.release();});
  fs.writeFileSync(source,`import {protectPosixWorkerLease} from ${JSON.stringify(moduleUrl)};try{protectPosixWorkerLease(${JSON.stringify(f.config)},${process.pid});process.exitCode=1}catch(e){if(!/did not inherit/.test(e.message))throw e;process.exitCode=17}finally{process.disconnect()}`);
  const child=spawn(process.execPath,[source],{stdio:['ignore','ignore','inherit','ipc',wrong]});
  assert.equal(await childExit(child),17);
  assert.throws(()=>runtime.acquire(f.config,'launcher'),{code:'RABI_AGENT_LEASE_BUSY'});
});

test('POSIX first-addon publisher crash leaves no truncated published native runtime', {skip:!supported}, async t=>{
  const f=fixture(t),source=path.join(f.root,'interrupted-publisher.mjs');
  fs.writeFileSync(source,`import fs from 'node:fs';import {materializePosixLeaseNative} from ${JSON.stringify(moduleUrl)};
const original=fs.writeFileSync;fs.writeFileSync=(fd,data,...args)=>{if(typeof fd==='number'&&Buffer.isBuffer(data)&&data.length>4096){original(fd,data.subarray(0,64),...args);fs.fsyncSync(fd);process.kill(process.pid,'SIGKILL');}return original(fd,data,...args)};
materializePosixLeaseNative(${JSON.stringify(f.root)});`);
  const publisher=spawn(process.execPath,[source],{stdio:'ignore'});
  await childExit(publisher);assert.equal(publisher.signalCode,'SIGKILL');
  const artifacts=fs.readdirSync(path.join(f.root,'.rabi-agent-native'));
  assert.equal(artifacts.filter(name=>name.endsWith('.node')).length,0);
  assert.equal(artifacts.some(name=>name.endsWith('.tmp')),true,'The interrupted private staging artifact remains recoverable');
  const lease=posixOwnerLeaseRuntime(f.config).acquire(f.config,'launcher');lease.release();
  assert.equal(fs.readdirSync(path.join(f.root,'.rabi-agent-native')).filter(name=>name.endsWith('.node')).length,1);
});
