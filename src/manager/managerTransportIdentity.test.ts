import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createManagerTransportIdentity } from "./managerTransportIdentity.js";
import { managerContextFromHeaders, MANAGER_CONTEXT_HEADER } from "../../apps/rabi-agent/lib/manager-transport-contract.mjs";

test("optional expected target is checked before dispatch; response identity belongs to ingress",async t=>{
  let revision="one", entered=0;const snapshots:unknown[]=[];
  const transport=createManagerTransportIdentity(()=>({applicationGenerationId:"app-one",managerInstanceId:"manager-one",metadataRevision:revision}));
  const server=http.createServer((request,response)=>{
    const context=transport.capture(response);snapshots.push(context);
    if(request.url==="/unauthorized"){response.writeHead(401).end();return;}
    if(transport.rejectChanged(request,response,context))return;
    entered++;
    if(request.url==="/proxy-array")response.writeHead(200,[MANAGER_CONTEXT_HEADER,"forged", "content-type","application/json"]);
    else response.writeHead(200,{"X-RabiRoute-Manager-Context":"forged","content-type":"application/json"});
    response.end(JSON.stringify({value:"business",protocol:transport.protocolInfo()}));
  });server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address();assert.ok(address&&typeof address!=="string");const base=`http://127.0.0.1:${address.port}`;
  const first=await fetch(base);assert.equal(first.status,200);assert.equal(managerContextFromHeaders(first.headers)?.managerInstanceId,"manager-one");await first.text();
  const headers={"x-rabiroute-expected-application-generation-id":"app-one","x-rabiroute-expected-manager-instance-id":"manager-one"};
  const same=await fetch(base+"/proxy-array",{headers});assert.equal(same.status,200);assert.equal(managerContextFromHeaders(same.headers)?.applicationGenerationId,"app-one");await same.text();assert.equal(snapshots[0],snapshots[1]);
  const before=entered;const wrong=await fetch(base,{method:"POST",headers:{...headers,"x-rabiroute-expected-manager-instance-id":"stale"},body:"not dispatched"});
  assert.equal(wrong.status,409);const error=await wrong.json() as {errorCode:string;executionState:string};assert.equal(error.errorCode,"MANAGER_IDENTITY_CHANGED");assert.equal(error.executionState,"not_started");assert.equal(entered,before);
  const unauthorized=await fetch(base+"/unauthorized",{headers:{"x-rabiroute-expected-manager-instance-id":"stale"}});assert.equal(unauthorized.status,401);await unauthorized.text();assert.equal(entered,before);
  revision="two";const changed=await fetch(base,{headers});assert.equal(changed.status,200);assert.equal(managerContextFromHeaders(changed.headers)?.metadataRevision,"two");await changed.text();
  assert.notEqual(snapshots[0],snapshots.at(-1));
});
test("old or malformed context headers stay unknown instead of being accepted as a modern identity",()=>{
  assert.equal(managerContextFromHeaders({}),undefined);assert.equal(managerContextFromHeaders({[MANAGER_CONTEXT_HEADER]:"invalid"}),undefined);
  assert.equal(managerContextFromHeaders({[MANAGER_CONTEXT_HEADER]:JSON.stringify({abi:2})}),undefined);
});
