import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ComputerControlClient } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlClient";
import { ComputerControlFiles } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlFiles";
const target={id:"computer",instanceId:"node",ownerDeviceId:"peer",name:"电脑",kind:"node" as const,local:false,status:"online" as const};
const hash=(value:Uint8Array)=>createHash("sha256").update(value).digest("hex");
test("settings read and CAS save use original target with partial patch then authoritative GET",async()=>{
 const calls:Array<{url:string,init?:RequestInit}>=[];
 const client=new ComputerControlClient(async(url,init)=>{calls.push({url:String(url),init});return Response.json({code:0,data:{settings:{enabled:false},schema:{}}},{headers:{etag:'"new"'}});},"test-token");
 const saved=await client.saveSettings(target,{features:{input:false}},'"old"');assert.equal(saved.etag,'"new"');assert.equal(calls.length,2);
 assert.match(calls[0]!.url,/peer\/http\/peer\/manager\/api\/lan-agent\/instances\/node\/computer-settings$/);assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)),{features:{input:false}});assert.equal(new Headers(calls[0]!.init!.headers).get("if-match"),'"old"');assert.equal(calls[1]!.init?.method,undefined);
});
test("computer action keeps exact request and uncertain failures never resend",async()=>{
 let count=0; const body={action:"input.execute",requestId:"original",controlSessionId:"session",actions:[{type:"text",text:"fixture"}]};
 const client=new ComputerControlClient(async(_url,init)=>{count++;assert.deepEqual(JSON.parse(String(init?.body)),body);throw new Error("connection lost");});
 await assert.rejects(client.action(target,body),/connection lost/);assert.equal(count,1);
});
test("browser upload uses shared chunks and exact SHA through original transfer ID",async()=>{
 const bytes=Uint8Array.from({length:70000},(_,index)=>index%251);const calls:Record<string,unknown>[]=[];let offset=0;
 const files=new ComputerControlFiles(async body=>{calls.push(body);assert.equal(body.uploadId,"original-upload");if(body.action==="upload.begin"){assert.equal(body.sha256,hash(bytes));assert.equal(body.size,bytes.length);}if(body.action==="upload.write"){const chunk=Buffer.from(String(body.data),"base64");assert.equal(body.offset,offset);assert.equal(body.sha256,hash(chunk));offset+=chunk.length;}return {uploadId:"original-upload",path:"D:/fixture",size:bytes.length,offset,state:body.action==="upload.commit"?"committed":"uploading"};});
 const result=await files.upload(new Blob([bytes]),"D:/fixture","original-upload",new AbortController().signal,()=>undefined);assert.equal(result.state,"committed");assert.deepEqual(calls.map(call=>call.action),["upload.begin","upload.write","upload.write","upload.commit"]);
});
test("cancelled upload does not issue another chunk or commit",async()=>{
 const abort=new AbortController();const calls:string[]=[];const files=new ComputerControlFiles(async body=>{calls.push(String(body.action));abort.abort();return {offset:0};});await assert.rejects(files.upload(new Blob([new Uint8Array(20)]),"D:/fixture","same",abort.signal,()=>undefined),/上传等待已停止/);assert.deepEqual(calls,["upload.begin"]);
});
test("download rejects corrupt bytes without presenting a completed file",async()=>{
 const files=new ComputerControlFiles(async body=>body.action==="file.stat"?{size:3,version:"v1"}:{data:"YWJj",sha256:"wrong",version:"v1",offset:0,nextOffset:3});await assert.rejects(files.download("D:/fixture",new AbortController().signal,()=>undefined),/校验不一致/);
});

test("actual client error handler preserves contract field and recovery guidance",async()=>{const client=new ComputerControlClient(async()=>Response.json({code:-1,error:"Computer feature disabled",errorCode:"COMPUTER_FEATURE_DISABLED",field:"computerSettings.features.input",repair:"RabiLink → 电脑控制 → 鼠标与键盘"},{status:409}));await assert.rejects(client.action(target,{action:"control.begin",requestId:"same"}),error=>{const value=error as Error;for(const text of ["Computer feature disabled","COMPUTER_FEATURE_DISABLED","computerSettings.features.input","RabiLink → 电脑控制 → 鼠标与键盘"])assert.ok(value.message.includes(text));return true;});});

test("PATCH application receipt survives the stored-settings GET without replay",async()=>{let calls=0;const client=new ComputerControlClient(async(_url,init)=>{calls++;return Response.json({code:0,data:{settings:{enabled:false},schema:{},revision:'"v2"',...(init?.method==="PATCH"?{execution:"unconfirmed",executionIssue:"Local execution is not confirmed."}:{})}},{headers:{etag:'"v2"'}});});const result=await client.saveSettings(target,{enabled:false},'"v1"');assert.equal(result.execution,"unconfirmed");assert.equal(result.executionIssue,"Local execution is not confirmed.");assert.equal(result.etag,'"v2"');assert.equal(calls,2);});
test("confirmed PATCH with failed readback remains saved and does not send another write",async()=>{let writes=0;const client=new ComputerControlClient(async(_url,init)=>{if(init?.method==="PATCH"){writes++;return Response.json({code:0,data:{settings:{enabled:false},schema:{},revision:'"v2"',execution:"unconfirmed"}},{headers:{etag:'"v2"'}});}throw new Error("readback unavailable");});const result=await client.saveSettings(target,{enabled:false},'"v1"');assert.equal(result.settings.enabled,false);assert.equal(result.execution,"unconfirmed");assert.ok(result.readbackIssue);assert.equal(writes,1);});
