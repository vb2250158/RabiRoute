import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn,fork} from "node:child_process";
import {once} from "node:events";
import {finished} from "node:stream/promises";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {createPlan,listPlanHistory} from "../roleKnowledge.js";
import {readPlanStoragePackage} from "../planStorageRepository.js";
import {storageInventoryRevisionToken} from "../shared/storageRevision.js";
import {durableDeliveryRequestDigest,durableDeliveryReceiptPath,readDurableDeliveryReceipt,receiptExecutionOwnerGone} from "./durableDeliveryIdempotency.js";
import {ManagerStorageMutationPool,ManagerStorageMutationError} from "./managerStorageMutationPool.js";
import {MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,validateManagerStorageMutationRequest,type ManagerStorageMutationRequest} from "./managerStorageMutationProtocol.js";

async function fixture(t:test.TestContext){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"storage-receipt-only-")),rolesRoot=path.join(root,"roles"),roleDir=path.join(rolesRoot,"Fixture");
 fs.mkdirSync(roleDir,{recursive:true});
 const plan=createPlan(roleDir,{id:"receipt-only-fixture",title:"Original plan",keywords:["fixture"],steps:[{id:"verify",title:"Verify"}],currentStepId:"verify"});
 const original=readPlanStoragePackage(roleDir,plan.id,"active");
 const options={idempotencyKey:"original-receipt-key",expectedRevision:storageInventoryRevisionToken(original.inventoryHash)};
 const patch={title:"Uncommitted candidate title"};
 const worker=spawn(process.execPath,["-e","process.exit(0)"],{stdio:"ignore",windowsHide:true});const oldPid=worker.pid!;await once(worker,"close");
 const pool=new ManagerStorageMutationPool({rolesRoot,applicationGenerationId:"fixture-generation",managerInstanceId:"fixture-manager",timeoutMs:10000});
 t.after(async()=>{await pool.stop();fs.rmSync(root,{recursive:true,force:true});});
 const receiptPath=durableDeliveryReceiptPath(path.join(roleDir,"runtime"),MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,options.idempotencyKey);
 const payload={roleId:"Fixture",planId:plan.id,task:{type:"plan_update",patch}};
 const record={version:1,deliveryId:options.idempotencyKey,requestDigest:durableDeliveryRequestDigest(payload),state:"sending",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),executionId:randomUUID(),ownerHost:os.hostname(),ownerPid:oldPid,leaseExpiresAt:new Date(Date.now()-1000).toISOString(),audit:{expectedRevision:options.expectedRevision}};
 fs.mkdirSync(path.dirname(receiptPath),{recursive:true});fs.writeFileSync(receiptPath,JSON.stringify(record));
 return {root,rolesRoot,roleDir,plan,original,options,patch,pool,receiptPath,record};
}
test("receipt-only settles a dead precommit owner through actual IPC and original same-key mutation cannot replay",async t=>{
 const f=await fixture(t);const history=listPlanHistory(f.roleDir,f.plan.id),before=readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash;
 const [first,second]=await Promise.all([f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,f.options),f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,f.options)]);
 for(const result of [first,second]){assert.equal(result.state,"completed");assert.equal(result.operationState,"failed");assert.equal(result.commitState,"not_committed");}
 const receipt=readDurableDeliveryReceipt(path.join(f.roleDir,"runtime"),MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,f.options.idempotencyKey)!;
 assert.equal(receipt.state,"completed");assert.equal((receipt.result as {domain:string}).domain,"rejected");
 assert.equal((receipt.result as {retryable:boolean}).retryable,false);
 const terminal=fs.readFileSync(f.receiptPath);
 await assert.rejects(f.pool.updatePlan("Fixture",f.plan.id,f.patch,f.options),error=>error instanceof ManagerStorageMutationError&&error.code==="aborted_before_commit"&&error.commitState==="not_committed");
 assert.deepEqual(fs.readFileSync(f.receiptPath),terminal);
 assert.equal(readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,before);
 assert.deepEqual(listPlanHistory(f.roleDir,f.plan.id),history);
});
test("payload conflicts and absent original receipts never reserve or execute",async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.receiptPath);
 const conflict=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,{title:"Different payload"},f.options);
 assert.equal(conflict.state,"conflict");assert.deepEqual(fs.readFileSync(f.receiptPath),before);
 const absentOptions={...f.options,idempotencyKey:"absent-key"};
 const absent=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,absentOptions);assert.equal(absent.state,"uncertain");
 assert.equal(fs.existsSync(durableDeliveryReceiptPath(path.join(f.roleDir,"runtime"),MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,absentOptions.idempotencyKey)),false);
});
test("receipt expiry alone cannot settle a live original process",async t=>{
 const f=await fixture(t);fs.writeFileSync(f.receiptPath,JSON.stringify({...f.record,ownerPid:process.pid}));
 const before=fs.readFileSync(f.receiptPath);
 const result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,f.options);
 assert.equal(result.state,"in_progress");assert.deepEqual(fs.readFileSync(f.receiptPath),before);
 assert.equal(receiptExecutionOwnerGone({...f.record,ownerPid:process.pid} as any),false);
 assert.equal(receiptExecutionOwnerGone(f.record as any),true);
});
test("committed plain legacy receipt remains a read-only terminal replay",async t=>{
 const f=await fixture(t);fs.writeFileSync(f.receiptPath,JSON.stringify({...f.record,state:"completed",result:{id:f.plan.id,title:"Legacy terminal value"}}));
 const before=fs.readFileSync(f.receiptPath),result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,f.options);
 assert.equal(result.state,"completed");assert.equal(result.operationState,"succeeded");assert.equal(result.commitState,"committed");
 if(result.state==="completed"&&result.operationState==="succeeded"){assert.equal((result.value as {title:string}).title,"Legacy terminal value");assert.equal(result.settlement,"not_attempted");}
 assert.deepEqual(fs.readFileSync(f.receiptPath),before);
});
test("receipt-only cancellation before queue dispatch leaves the original sending bytes",async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.receiptPath),controller=new AbortController();controller.abort();
 await assert.rejects(f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,{...f.options,signal:controller.signal}),error=>error instanceof ManagerStorageMutationError&&error.code==="aborted");
 assert.deepEqual(fs.readFileSync(f.receiptPath),before);assert.equal(f.pool.status().spawnedChildren,0);
});
test("protocol 3 explicitly restricts receipt-only to the original plan update",()=>{
 const identity={rolesRoot:path.resolve("fixture"),applicationGenerationId:"app",managerInstanceId:"manager",storageGenerationLease:"lease"};
 const request={protocolVersion:MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,mode:"receipt_only",requestId:"request",fence:{...identity,roleId:"Fixture",planId:"p"},expectedRevision:null,task:{type:"plan_update",patch:{title:"fixture"}}} as unknown as ManagerStorageMutationRequest;
 assert.equal(validateManagerStorageMutationRequest(request,identity),request);
 assert.throws(()=>validateManagerStorageMutationRequest({...request,protocolVersion:2} as any,identity),/protocol version/);
 assert.throws(()=>validateManagerStorageMutationRequest({...request,mode:"receipt-only-typo"} as any,identity),/execution mode/);
 assert.throws(()=>validateManagerStorageMutationRequest({...request,task:{type:"plan_create",input:{id:"p",title:"fixture"}}} as any,identity),/original plan_update/);
});
test("a real new worker rejects an old protocol command before domain access",async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"receipt-protocol-ipc-"));
 const child=fork(new URL("./managerStorageMutationChild.ts",import.meta.url),[],{execArgv:["--import","tsx"],env:{...process.env,RABIROUTE_STORAGE_ROLES_ROOT:root,RABIROUTE_APPLICATION_GENERATION_ID:"app",RABIROUTE_MANAGER_INSTANCE_ID:"manager",RABIROUTE_STORAGE_GENERATION_LEASE:"lease",RABIROUTE_MANAGER_STORAGE_MUTATION_PROCESS:"1"},stdio:["ignore","pipe","pipe","ipc"]});
 child.stdout?.resume(); child.stderr?.resume();
 const exited=once(child,"exit");
 t.after(async()=>{
  let timer:NodeJS.Timeout|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error("Fixture worker did not close after IPC disconnect. pid="+child.pid+" exit="+child.exitCode+" signal="+child.signalCode+" connected="+child.connected+" stdout="+child.stdout?.readableEnded+" stderr="+child.stderr?.readableEnded+"")),5000);});
  if(child.connected)child.disconnect();
  try{const [code]=await Promise.race([exited,deadline]);assert.equal(code,0);await Promise.all([child.stdout?finished(child.stdout):undefined,child.stderr?finished(child.stderr):undefined]);}finally{if(timer)clearTimeout(timer);}
  fs.rmSync(root,{recursive:true,force:true});
 });
 const response=Promise.race([once(child,"message"),once(child,"exit").then(([code])=>{throw Error("Fixture worker exited before response: "+code);})]);
 child.send({protocolVersion:2,requestId:"old-protocol",mode:"receipt_only",fence:{applicationGenerationId:"app",managerInstanceId:"manager",storageGenerationLease:"lease",roleId:"Fixture",planId:"p"},expectedRevision:null,task:{type:"plan_update",patch:{title:"must never execute"}}});
 const [result]=await response;assert.equal(result.ok,false);assert.match(result.message,/protocol version/);assert.equal(result.protocolVersion,3);assert.deepEqual(fs.readdirSync(root),[]);
});


test("actual committed domain history restores an original result without changing a later plan",async t=>{
 const f=await fixture(t);
 const committed=await f.pool.updatePlan("Fixture",f.plan.id,f.patch,f.options);
 assert.equal(committed.title,f.patch.title);
 fs.writeFileSync(f.receiptPath,JSON.stringify(f.record));
 const current=readPlanStoragePackage(f.roleDir,f.plan.id,"active");
 await f.pool.updatePlan("Fixture",f.plan.id,{title:"Later independent update"},{idempotencyKey:"later-independent",expectedRevision:storageInventoryRevisionToken(current.inventoryHash)});
 const before=readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,history=listPlanHistory(f.roleDir,f.plan.id);
 const result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,f.options);
 assert.equal(result.operationState,"succeeded");assert.equal(result.commitState,"committed");
 if(result.state==="completed"&&result.operationState==="succeeded")assert.equal((result.value as {title:string}).title,f.patch.title);
 assert.equal(readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,before);
 assert.deepEqual(listPlanHistory(f.roleDir,f.plan.id),history);
});
test("an actual prepared lifecycle WAL remains unresolved without recovery or receipt edits",async t=>{
 const {commitPlanLifecycleTransitionUnderLease,withPlanStorageLease}=await import("../planStorageRepository.js");
 const {createHash}=await import("node:crypto");
 const f=await fixture(t),beforeReceipt=fs.readFileSync(f.receiptPath),rename=fs.renameSync;
 const files=f.original.files.map(file=>{
  const bytes=file.path==="plan.json"?Buffer.from(JSON.stringify({...JSON.parse(file.content.toString()),...f.patch,storageMutationRequestId:f.options.idempotencyKey})+"\n"):file.content;
  return {path:file.path,content:bytes,size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
 });
 const spy=t.mock.method(fs,"renameSync",((source:fs.PathLike,target:fs.PathLike)=>{
  if(String(source)===path.join(f.roleDir,"plans","active",f.plan.id)&&path.basename(String(target))==="previous")throw Object.assign(Error("fixture precommit publication interrupted"),{code:"EIO"});
  return rename(source,target);
 }) as typeof fs.renameSync);
 assert.throws(()=>withPlanStorageLease(f.roleDir,f.plan.id,lease=>commitPlanLifecycleTransitionUnderLease(lease,{transactionId:"prepared-original",kind:"plan-update",fromBucket:"active",toBucket:"active",expectedSourceInventoryHash:f.original.inventoryHash,files})),/publication interrupted/);
 spy.mock.restore();
 const wal=path.join(f.roleDir,"plans","quarantine","plan-storage-lifecycle-transactions",f.plan.id,"prepared-original","manifest.json"),walBefore=fs.readFileSync(wal);
 const result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,f.options);
 assert.equal(result.state,"uncertain");assert.deepEqual(fs.readFileSync(f.receiptPath),beforeReceipt);
 assert.deepEqual(fs.readFileSync(wal),walBefore);assert.equal(readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,f.original.inventoryHash);
});
test("a terminal write with failed readback stays uncertain then returns the original terminal result",async t=>{
 const {reconcileManagerStorageMutationReceipt}=await import("./managerStorageMutationReceipt.js");
 const f=await fixture(t),read=fs.readFileSync;let rejectedReadback=false;
 const spy=t.mock.method(fs,"readFileSync",((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
  const value=Reflect.apply(read,fs,[file,...args]);
  if(String(file)===f.receiptPath&&!rejectedReadback){
   const parsed=JSON.parse(Buffer.isBuffer(value)?value.toString():String(value));
   if(parsed.state==="completed"){rejectedReadback=true;throw Object.assign(Error("fixture readback unavailable after durable write"),{code:"EIO"});}
  }
  return value;
 }) as typeof fs.readFileSync);
 const request={protocolVersion:MANAGER_STORAGE_MUTATION_PROTOCOL_VERSION,mode:"receipt_only",requestId:f.options.idempotencyKey,fence:{applicationGenerationId:"fixture",managerInstanceId:"fixture",storageGenerationLease:"fixture",roleId:"Fixture",planId:f.plan.id},expectedRevision:f.options.expectedRevision,task:{type:"plan_update",patch:f.patch}} as ManagerStorageMutationRequest;
 const first=await reconcileManagerStorageMutationReceipt(request,f.roleDir);spy.mock.restore();
 assert.equal(rejectedReadback,true);assert.equal(first.state,"uncertain");
 const terminal=fs.readFileSync(f.receiptPath);assert.equal(JSON.parse(terminal.toString()).state,"completed");
 const second=await reconcileManagerStorageMutationReceipt(request,f.roleDir);
 assert.equal(second.state,"completed");assert.equal(second.commitState,"not_committed");assert.deepEqual(fs.readFileSync(f.receiptPath),terminal);
 assert.equal(readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,f.original.inventoryHash);
});


test("an installed protocol 2 worker rejects protocol 3 receipt-only before any domain writes",{skip:!process.env.RABIROUTE_OLD_STORAGE_CHILD},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"old-receipt-protocol-ipc-"));
 const child=fork(process.env.RABIROUTE_OLD_STORAGE_CHILD!,[],{execArgv:[],env:{...process.env,RABIROUTE_STORAGE_ROLES_ROOT:root,RABIROUTE_APPLICATION_GENERATION_ID:"old-fixture-app",RABIROUTE_MANAGER_INSTANCE_ID:"old-fixture-manager",RABIROUTE_STORAGE_GENERATION_LEASE:"old-fixture-lease",RABIROUTE_MANAGER_STORAGE_MUTATION_PROCESS:"1"},stdio:["ignore","pipe","pipe","ipc"]});
 child.stdout?.resume();child.stderr?.resume();const exited=once(child,"exit");
 t.after(async()=>{
  let timer:NodeJS.Timeout|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error("Old fixture worker exit was not confirmed.")),5000);});
  if(child.connected)child.disconnect();
  try{const[code]=await Promise.race([exited,deadline]);assert.equal(code,0);await Promise.all([child.stdout?finished(child.stdout):undefined,child.stderr?finished(child.stderr):undefined]);}
  finally{if(timer)clearTimeout(timer);}
  assert.deepEqual(fs.readdirSync(root),[]);fs.rmSync(root,{recursive:true,force:true});
 });
 const response=Promise.race([once(child,"message"),exited.then(([code])=>{throw Error("Old fixture worker exited before protocol response: "+code);})]);
 child.send({protocolVersion:3,requestId:"new-mode-old-worker",mode:"receipt_only",fence:{applicationGenerationId:"old-fixture-app",managerInstanceId:"old-fixture-manager",storageGenerationLease:"old-fixture-lease",roleId:"Fixture",planId:"fixture-plan"},expectedRevision:null,task:{type:"plan_update",patch:{title:"never execute"}}});
 const[result]=await response;assert.equal(result.ok,false);assert.match(result.message,/protocol version/);assert.equal(result.protocolVersion,2);assert.deepEqual(fs.readdirSync(root),[]);
});


test("receipt-only null uses its original durable audit anchor through the actual worker",async t=>{
 const f=await fixture(t),before=readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash;
 const result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,{...f.options,expectedRevision:null});
 assert.equal(result.state,"completed");assert.equal(result.operationState,"failed");assert.equal(result.commitState,"not_committed");
 assert.equal(readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,before);
 const stored=readDurableDeliveryReceipt(path.join(f.roleDir,"runtime"),MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,f.options.idempotencyKey)!;
 assert.equal((stored.audit as {expectedRevision:string}).expectedRevision,f.options.expectedRevision);
});
test("receipt-only explicit version mismatch preserves the original receipt through actual IPC",async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.receiptPath),inventory=readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash;
 const result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,{...f.options,expectedRevision:"inventory-sha256:"+"0".repeat(64)});
 assert.equal(result.state,"uncertain");assert.equal(result.commitState,"unknown");
 assert.deepEqual(fs.readFileSync(f.receiptPath),before);
 assert.equal(readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,inventory);
});
test("receipt-only missing or invalid audit anchor remains unknown without caller or current-version fallback",async t=>{
 const f=await fixture(t);
 for(const audit of [undefined,{}, {expectedRevision:null},{expectedRevision:"broken"},{expectedRevision:42}]){
  fs.writeFileSync(f.receiptPath,JSON.stringify({...f.record,audit}));
  const before=fs.readFileSync(f.receiptPath);
  const result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,{...f.options,expectedRevision:null});
  assert.equal(result.state,"uncertain");assert.equal(result.commitState,"unknown");
  assert.deepEqual(fs.readFileSync(f.receiptPath),before);
 }
});

test("original committed history closes nonterminal receipts even when legacy audit anchors are missing or malformed",async t=>{
 const f=await fixture(t);
 const committed=await f.pool.updatePlan("Fixture",f.plan.id,f.patch,f.options);
 assert.equal(committed.title,f.patch.title);
 const committedInventory=readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash;
 const committedHistory=listPlanHistory(f.roleDir,f.plan.id);
 for(const audit of [undefined,{}, {expectedRevision:null},{expectedRevision:"broken"},{expectedRevision:42}]){
  fs.writeFileSync(f.receiptPath,JSON.stringify({...f.record,audit}));
  const result=await f.pool.reconcilePlanUpdateReceipt("Fixture",f.plan.id,f.patch,{...f.options,expectedRevision:null});
  assert.equal(result.state,"completed");assert.equal(result.operationState,"succeeded");assert.equal(result.commitState,"committed");
  if(result.state==="completed"&&result.operationState==="succeeded"){
   assert.equal((result.value as {title:string}).title,f.patch.title);
   assert.equal(result.settlement,"committed");
  }
  assert.equal(readPlanStoragePackage(f.roleDir,f.plan.id,"active").inventoryHash,committedInventory);
  assert.deepEqual(listPlanHistory(f.roleDir,f.plan.id),committedHistory);
  const terminal=readDurableDeliveryReceipt(path.join(f.roleDir,"runtime"),MANAGER_STORAGE_MUTATION_RECEIPT_NAMESPACE,f.options.idempotencyKey)!;
  assert.equal(terminal.state,"completed");assert.equal((terminal.result as {domain:string}).domain,"committed");
 }
});
