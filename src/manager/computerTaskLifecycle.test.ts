import test from "node:test";import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import {computerAgentSession,endComputerTrackingForPlan,computerAgentSourceId} from "./computerTaskLifecycle.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type {LanAgentRegistry} from "./lanAgentRegistry.js";
test("only a true plan end with an exact local-owner instance binding clears its source task across capable computers",async()=>{
 const calls:unknown[]=[];const errors:string[]=[];
 const registry={listInstances:()=>[{instanceId:"local",local:true,connected:true,agents:[],computerCapabilities:["annotation"]},{instanceId:"new-node",local:false,connected:true,agents:[],computerCapabilities:["annotation"]},{instanceId:"old-node",local:false,connected:true,agents:[],computerCapabilities:["files"]}],endComputerTask:async(...args:unknown[])=>{calls.push(args);if(args[0]==="new-node")throw Error("fixture unavailable");}} as Pick<LanAgentRegistry,"listInstances"|"endComputerTask">;
 const binding={agentType:"codex",sessionId:"same-literal-session",instanceBinding:{instanceId:"source-node",ownerDeviceId:"this-pc"}};
 await endComputerTrackingForPlan({activationStatus:"进行中",taskBinding:binding},registry,"this-pc",()=>{});assert.equal(calls.length,0);
 await endComputerTrackingForPlan({activationStatus:"已完成",taskBinding:binding},registry,"this-pc",id=>errors.push(id));
 assert.deepEqual(calls,[["local",binding.sessionId,computerAgentSourceId("source-node","codex",binding.sessionId)],["new-node",binding.sessionId,computerAgentSourceId("source-node","codex",binding.sessionId)]]);assert.deepEqual(errors,["new-node"]);
 calls.length=0;
 await endComputerTrackingForPlan({activationStatus:"已完成",taskBinding:{...binding,instanceBinding:{instanceId:"source-node",ownerDeviceId:"another-pc"}}},registry,"this-pc",()=>{});
 await endComputerTrackingForPlan({activationStatus:"已归档",taskBinding:{agentType:"codex",sessionId:"local-unattributed"}},registry,"this-pc",()=>{});
 assert.equal(calls.length,0,"neither a foreign manager nor an unrecorded local task is guessed");
 assert.notEqual(computerAgentSourceId("node-a","codex","same"),computerAgentSourceId("node-b","codex","same"));
});

test("authenticated local Agent sessions use the same ownership key as the task lifecycle", () => {
 const request = (id: string) => ({
   socket: { remoteAddress: "127.0.0.1" },
   headers: { "x-rabiroute-agent-type": "codex", "x-rabiroute-session-id": id }
 }) as unknown as IncomingMessage;
 const first = request("session-a"), second = request("session-b");
 assert.equal(computerAgentSession(first, "this-host"), undefined);
 markAuthenticatedConnectionRequest(first); markAuthenticatedConnectionRequest(second);
 const a = computerAgentSession(first, "this-host"), b = computerAgentSession(second, "this-host");
 assert.equal(a?.sourceId, computerAgentSourceId("this-host", "codex", "session-a"));
 assert.equal(a?.taskId, "session-a");
 assert.notEqual(a?.sourceId, b?.sourceId);
});
