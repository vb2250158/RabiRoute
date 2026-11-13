import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { ComputerService } from "../lib/computer-service.mjs";
import { NativeComputerClient } from "../lib/computer-native-client.mjs";
import { DEFAULT_COMPUTER_SETTINGS } from "../lib/computer-control-contract.mjs";

const require=createRequire(import.meta.url);
test("desktop-only replacement joins real original handle while uploads, files and receipts retain owners", async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rabi-desktop-slot-real-"));
  const fixture=path.join(root,"worker.mjs");
  await fs.writeFile(fixture, `import readline from 'node:readline';
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{const m=JSON.parse(line);const result=m.action==='capabilities'?{protocolVersion:2,trackingAvailable:true}:m.action==='control.begin'?{visible:true,hotkey:{registered:false}}:{state:'completed',releaseState:'released'};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});
rl.on('close',()=>{setTimeout(()=>process.exit(0),150);});`);
  const natives=[];
  const service=new ComputerService({uploadHistoryRoot:path.join(root,"uploads"),receiptRoot:path.join(root,"receipts"),
    getSettings:()=>DEFAULT_COMPUTER_SETTINGS,resolveDesktopRelease:async reference=>({version:reference}),
    nativeFactory:({children,timeout,release})=>{const n=new NativeComputerClient({children,timeout,executable:process.execPath,args:[fixture,release.version]}); n.observed=[];const request=n.request.bind(n);n.request=(action,...args)=>{n.observed.push(action);return request(action,...args);};natives.push(n);return n;}});
  t.after(async()=>{await service.stop();await fs.rm(root,{recursive:true,force:true});});
  const input={action:"control.begin",requestId:randomUUID()};const context={sourceId:"controlled-fixture"};
  const begin=await service.execute(input,context);assert.equal(begin.state,"active");
  const old=natives[0].child;assert.ok(old?.pid);
  let handle,wait,closeHandle;
  if(process.platform==='win32'){
    const koffi=require('koffi');const kernel=koffi.load('kernel32.dll');
    const open=kernel.func('void * __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)');
    wait=kernel.func('uint32 __stdcall WaitForSingleObject(void * hHandle, uint32 dwMilliseconds)');
    closeHandle=kernel.func('int __stdcall CloseHandle(void * hObject)');handle=open(0x00100000,0,old.pid);assert.ok(handle);
    t.after(()=>{if(handle)closeHandle(handle);});
  }
  const data=Buffer.from('upload stays on original owner');const uploadId=randomUUID();const output=path.join(root,"saved.bin");
  await service.execute({action:'upload.begin',uploadId,path:output,size:data.length,sha256:createHash('sha256').update(data).digest('hex')});
  const originalControl=service.control,originalUploads=service.uploads,originalReceipts=service.control.receipts;
  const prepared=await service.prepareDesktopRelease('new-native');
  const adopting=service.activateDesktopRelease(prepared,0);
  const ending=service.execute({action:'control.end',controlSessionId:begin.controlSessionId},context);
  const cancelling=service.execute({action:'input.cancel',requestId:input.requestId},context);
  const clearing=service.execute({action:'annotation.clear',layerId:'retired-fixture-layer'},context);
  await new Promise(resolve=>setTimeout(resolve,15));
  const stat=await service.execute({action:'file.stat',path:fixture});assert.ok(stat);
  const status=await service.execute({action:'upload.status',uploadId});assert.equal(status.state,'uploading');
  await adopting;
  assert.equal((await ending).state,'ended');
  assert.equal((await cancelling).requestId,input.requestId);
  assert.equal(service.control.receipts.get(input.requestId).cancelled,true);
  assert.equal((await clearing).state,'cleared');
  assert.deepEqual(natives[1].observed,['capabilities'],'old recovery commands do not enter the new native worker');
  if(handle)assert.equal(wait(handle,0),0,'method return proves original kernel handle signaled, no test-side wait');
  assert.equal(service.control,originalControl);assert.equal(service.uploads,originalUploads);assert.equal(service.control.receipts,originalReceipts);
  const receipt=await service.execute(input,context);assert.equal(receipt.state,'ended');
  assert.equal(service.control.session,null);assert.equal(service.control.activeLayers.size,0);assert.equal(service.control.activeTrackers.size,0);
  assert.equal((await service.execute({action:'upload.status',uploadId})).state,'uploading');
  await service.execute({action:'upload.abort',uploadId});
  const second=await service.execute({action:'control.begin',requestId:randomUUID()},context);assert.equal(second.state,'active');
  await service.prepareDesktopRelease('unselected-final-candidate');
  for (const native of natives) if(native.child) native.child.kill=()=>{throw new Error('Generic resource owner must not kill a desktop-slot child');};
  await service.stop();assert.equal(service.children.size,0);
});
