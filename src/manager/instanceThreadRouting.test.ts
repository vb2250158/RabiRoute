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
