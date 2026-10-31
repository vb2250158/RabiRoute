import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { __test } from "../rabi-agent.mjs";
import { normalizeAllowedWorkspaces, resolveRealDirectory } from "../lib/cwd-policy.mjs";
import { agentCatalog, configureInstanceAgent, resolveInstanceAgent, withoutSessionBindings } from "../lib/instance-agents.mjs";
const config={defaultWorkspace:resolveRealDirectory(os.tmpdir()),allowedWorkspaces:normalizeAllowedWorkspaces([],os.tmpdir()),agents:[]};
test("empty backend directory executes any explicit supported type and full session without persisting a binding",()=>{
 const before=structuredClone(config);for(const targetAgent of ["codex-desktop","dsh"]){assert.equal(resolveInstanceAgent(config,{targetAgent,threadId:"unregistered-full-session"}).provider,targetAgent);}
 assert.deepEqual(config,before); for(const request of [{threadId:"session"},{targetAgent:"dsh"},{targetAgent:"dsh",threadId:" short "}])assert.throws(()=>resolveInstanceAgent(config,request),/Explicit/);
});
test("migration removes all saved session claims while preserving credentials, directories and backend settings",()=>{
 const old={...config,nodeCredential:"fixture-private",agentType:"codex-desktop",codexDesktop:{threadId:"old",model:"model"},dsh:{baseUrl:"http://localhost:4510",sessionId:"old"},agents:[{agentId:"backend",provider:"dsh",sessionId:"old",managedSessionIds:["child"],enabled:false,dsh:{baseUrl:"http://localhost:4510",sessionId:"old"}}]};
 const next=withoutSessionBindings(old);assert.equal(next.nodeCredential,old.nodeCredential);assert.deepEqual(next.codexDesktop,{model:"model"});assert.equal(next.agentType,undefined);assert.equal(JSON.stringify(next).includes('"sessionId"'),false);assert.equal(next.agents[0].enabled,undefined);assert.equal(old.agents[0].sessionId,"old");
});
test("backend configuration never saves a default session and instance enablement has no additional backend grant",()=>{
 const next=configureInstanceAgent(config,{provider:"codex-desktop"});assert.equal(resolveInstanceAgent(next,{targetAgent:"codex-desktop",threadId:"any"}).provider,"codex-desktop");
 assert.throws(()=>configureInstanceAgent(config,{provider:"codex-desktop",sessionId:"old"}),/removed/);
 const catalog=agentCatalog(next);assert.equal(catalog[0].sessionId,undefined);assert.equal(catalog[0].managedSessionIds,undefined);assert.equal(catalog[0].enabled,true);
});

test("bad optional backend rows preserve the config bytes while healthy backends and computer startup remain usable", async t => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"rabi-agent-bad-profile-"));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const configPath=path.join(directory,"config.json");
 const healthy={agentId:"healthy",provider:"codex-desktop",workspace:directory,sessionId:"retired-session"};
 const raw={schemaVersion:1,nodeId:"fixture-node",nodeCredential:"fixture-credential",releasePublicKeySha256:"a".repeat(64),managerUrl:"http://127.0.0.1:34567",defaultWorkspace:directory,agents:[null,healthy,42,[]]};
 const bytes=JSON.stringify(raw,null,3)+"\n";fs.writeFileSync(configPath,bytes);
 const diagnostics=[];t.mock.method(console,"warn",value=>diagnostics.push(value));
 const loaded=__test.readConfig(configPath);
 assert.equal(fs.readFileSync(configPath,"utf8"),bytes);
 assert.deepEqual(fs.readdirSync(directory),["config.json"]);
 assert.deepEqual(loaded.agents,raw.agents);
 assert.equal(agentCatalog(loaded).length,1);
 assert.equal(resolveInstanceAgent(loaded,{targetAgent:"codex-desktop",threadId:"explicit-current-session"}).agentId,"healthy");
 assert.equal(resolveInstanceAgent(loaded,{targetAgent:"codex-desktop",threadId:"explicit-current-session"}).sessionId,undefined);
 assert.match(diagnostics[0],/agents\[0, 2, 3\]/);
 assert.equal(diagnostics[0].includes("fixture-credential"),false);
 const edited=configureInstanceAgent(loaded,{agentId:"healthy",name:"Updated"});
 assert.equal(edited.agents[0],null);assert.equal(edited.agents[2],42);assert.deepEqual(edited.agents[3],[]);
 const runtime=new __test.RabiAgentRuntime(loaded,configPath);
 try { assert.ok(runtime.computer); assert.equal(runtime.stopped,false); }
 finally { await runtime.stop(); }
});
