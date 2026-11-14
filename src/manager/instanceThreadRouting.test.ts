import test from "node:test";
import assert from "node:assert/strict";
import { routeInstanceThread } from "./instanceThreadRouting.js";
import type { AgentInstance } from "../shared/agentInstance.js";

test("explicit computer, provider and session work with an empty Agent catalog; session IDs never infer another owner",async()=>{
 const instances:AgentInstance[]=[{instanceId:"remote",local:false,connected:true,enabled:true,agents:[]}];const calls:unknown[]=[];const transport={instances:()=>instances,manage:async(instanceId:string,params:Record<string,unknown>)=>{calls.push({instanceId,params});return {statusCode:200,data:{thread:{id:params.threadId}}};}};
 assert.equal(await routeInstanceThread({action:"read",threadId:"any"},transport),undefined);
 const explicit={action:"read" as const,threadId:"full-id",agentAdapter:"dsh" as const,instanceBinding:{instanceId:"remote",agentId:"dsh"}};
 assert.equal((await routeInstanceThread(explicit,transport))?.statusCode,200);assert.equal(calls.length,1);
 await assert.rejects(routeInstanceThread({...explicit,agentAdapter:undefined},transport),/Explicit/);instances[0]!.enabled=false;await assert.rejects(routeInstanceThread(explicit,transport),/disabled/);
 assert.equal(await routeInstanceThread({action:"read",threadId:"full-id",agentAdapter:"codex",agentTargetId:"local:codex"},transport),undefined);
});

test("DSBot native actions retain the configured remote owner and never become local Session sends", async () => {
  const actions = ["ds_bot_catalog", "ds_bot_deliver", "ds_bot_reconcile"] as const;
  const seen: unknown[] = [];
  for (const action of actions) {
    const request = { action, agentAdapter: "dsh" as const, instanceBinding: { instanceId: "remote", agentId: "configured-dsh" }, dsBot: { botScopeId: "scope", botId: "bot" }, deliveryId: "original", prompt: "task" };
    const result = await routeInstanceThread(request, { instances: () => [{ instanceId: "remote", local: false, connected: true, agents: [] }], manage: async (instance, params) => { seen.push([instance, params]); return { statusCode: 200, data: { dsBot: { state: "accepted" } } }; } });
    assert.equal(result?.statusCode, 200);
    const { instanceBinding: _binding, ...body } = request;
    assert.deepEqual((seen.at(-1) as [string, Record<string, unknown>])[1], { ...body, agentId: "configured-dsh" });
  }
});

test("DSBot peer actions preserve original owner and offline selection has no local fallback", async () => {
  const request = { action: "ds_bot_deliver" as const, agentAdapter: "dsh" as const, instanceBinding: { instanceId: "selected", agentId: "dsh", ownerDeviceId: "peer" }, dsBot: { botScopeId: "scope", botId: "bot" }, deliveryId: "original", prompt: "task" };
  let calls = 0;
  const result = await routeInstanceThread(request, { instances: () => [], manage: async () => { throw new Error("wrong local lane"); }, peer: async (binding, forwarded) => { calls++; assert.deepEqual(binding, request.instanceBinding); assert.deepEqual(forwarded, request); return { statusCode: 200, data: { ok: true } }; } });
  assert.equal(result?.statusCode, 200); assert.equal(calls, 1);
  await assert.rejects(routeInstanceThread({ ...request, instanceBinding: { instanceId: "offline", agentId: "dsh" } }, { instances: () => [], manage: async () => { throw new Error("must not execute"); } }), /offline/);
});
