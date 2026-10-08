import assert from "node:assert/strict";
import test from "node:test";
import {vacuumRemoteClient} from "../src/vacuumRemoteClient.js";
test("lost direction response queries its original receipt, sends only one fenced POST and no raw HA command",async()=>{
 const original=globalThis.fetch,requests:Array<{url:string;init:RequestInit}>=[];
 const session={schemaVersion:1 as const,sessionId:"session",resourceId:"home:ha:vacuum.test",state:"ready" as const,stateVersion:"version",startedAt:"now",updatedAt:"now",confirmation:"provider_acceptance" as const};
 globalThis.fetch=async(input,init={})=>{const url=String(input);requests.push({url,init});if(url==="/meta")return Response.json({applicationGenerationId:"generation",managerInstanceId:"instance"});if(init.method==="POST")throw Error("lost response");return Response.json({code:0,data:{state:"completed",result:session}});};
 try{assert.equal((await vacuumRemoteClient.pulse(session,"left","remote-client-key-01")).state,"ready");const posts=requests.filter(r=>r.init.method==="POST");assert.equal(posts.length,1);assert.equal((posts[0]!.init.headers as Record<string,string>)["x-rabiroute-expected-manager-instance-id"],"instance");assert.deepEqual(JSON.parse(String(posts[0]!.init.body)),{sessionId:"session",expectedStateVersion:"version",direction:"left",durationMs:250});assert.ok(requests.some(r=>r.url.endsWith("idempotencyKey=remote-client-key-01")));}finally{globalThis.fetch=original;}
});
