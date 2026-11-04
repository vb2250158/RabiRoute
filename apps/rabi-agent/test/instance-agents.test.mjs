import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { __test } from "../rabi-agent.mjs";
import { normalizeAllowedWorkspaces, resolveRealDirectory } from "../lib/cwd-policy.mjs";
import { agentCatalog, configureInstanceAgent as configureNativeInstanceAgent, resolveInstanceAgent as resolveNativeInstanceAgent, withoutSessionBindings } from "../lib/instance-agents.mjs";
const providers = [{ type: "codex" }, { type: "dsh" }];
const configureInstanceAgent = (config, input) => configureNativeInstanceAgent(config, input, providers);
const resolveInstanceAgent = (config, input) => resolveNativeInstanceAgent(config, input, providers);
const config={defaultWorkspace:resolveRealDirectory(os.tmpdir()),allowedWorkspaces:normalizeAllowedWorkspaces([],os.tmpdir()),agents:[]};
test("empty backend directory executes any explicit supported type and full session without persisting a binding",()=>{
 const before=structuredClone(config);for(const targetAgent of ["codex-desktop","dsh"]){assert.equal(resolveInstanceAgent(config,{targetAgent,threadId:"unregistered-full-session"}).provider,targetAgent);}
 assert.deepEqual(config,before); for(const request of [{threadId:"session"},{targetAgent:"dsh"},{targetAgent:"dsh",threadId:" short "}])assert.throws(()=>resolveInstanceAgent(config,request),/Explicit/);
});

test("an explicit backend identity cannot fall back to another backend or its default workspace", () => {
  const configured = {
    ...config,
    agents: [
      { agentId: "saved-codex", provider: "codex-desktop", workspace: "D:/fixture/original", model: "original-model" },
      { agentId: "saved-dsh", provider: "dsh", workspace: "D:/fixture/dsh", dsh: { baseUrl: "http://127.0.0.1:4510" } }
    ]
  };
  const before = structuredClone(configured);
  for (const targetAgent of ["codex-desktop", "dsh"]) {
    const request = { targetAgent, agentId: "deleted-backend", threadId: "original-full-session" };
    const originalRequest = structuredClone(request);
    assert.throws(() => resolveInstanceAgent(configured, request), /backend.*unavailable/i);
    assert.deepEqual(request, originalRequest);
  }
  for (const agentId of [null, false, true, 0, [], ["saved-codex"], {}]) {
    assert.throws(() => resolveInstanceAgent(configured, {
      targetAgent: "codex-desktop", agentId, threadId: "original-full-session"
    }), /backend.*string/i);
  }
  assert.throws(() => resolveInstanceAgent(configured, {
    targetAgent: "dsh", agentId: "saved-codex", threadId: "original-full-session"
  }), /backend.*unavailable/i);
  const codex = resolveInstanceAgent(configured, {
    targetAgent: "codex-desktop", agentId: "saved-codex", threadId: "original-full-session"
  });
  assert.equal(codex.agentId, "saved-codex");
  assert.equal(codex.workspace, "D:/fixture/original");
  assert.equal(codex.model, "original-model");
  const dsh = resolveInstanceAgent(configured, {
    targetAgent: "dsh", agentId: "saved-dsh", threadId: "original-full-session"
  });
  assert.equal(dsh.agentId, "saved-dsh");
  assert.equal(dsh.workspace, "D:/fixture/dsh");
  assert.equal(dsh.dsh.baseUrl, "http://127.0.0.1:4510");
  for (const agentId of [undefined, ""]) {
    const implicit = resolveInstanceAgent(config, { targetAgent: "codex-desktop", agentId, threadId: "original-full-session" });
    assert.equal(implicit.provider, "codex-desktop");
    assert.equal(implicit.workspace, config.defaultWorkspace);
  }
  assert.deepEqual(configured, before);
});
test("Codex provider aliases preserve the explicitly selected backend and detect ambiguous implicit selection", () => {
  for (const [provider, targetAgent] of [["codex", "codex-desktop"], ["codex-desktop", "codex"]]) {
    const configured = { ...config, agents: [{ agentId: "original-backend", provider,
      workspace: "D:/fixture/original", model: "original-model", reasoningEffort: "high" }] };
    const request = { targetAgent, agentId: "original-backend", threadId: "original-full-session" };
    const before = structuredClone({ configured, request });
    const selected = resolveInstanceAgent(configured, request);
    assert.deepEqual(selected, configured.agents[0]);
    assert.equal(selected.agentId, "original-backend");
    assert.equal(selected.provider, provider);
    assert.equal(selected.workspace, "D:/fixture/original");
    assert.equal(selected.model, "original-model");
    assert.throws(() => resolveInstanceAgent(configured, { ...request, agentId: "missing-backend" }), /backend.*unavailable/i);
    assert.deepEqual({ configured, request }, before);
  }
  const configured = { ...config, agents: [
    { agentId: "native-backend", provider: "codex", workspace: "D:/fixture/native", model: "native-model" },
    { agentId: "legacy-backend", provider: "codex-desktop", workspace: "D:/fixture/legacy", model: "legacy-model" }
  ] };
  for (const targetAgent of ["codex", "codex-desktop"]) {
    assert.throws(() => resolveInstanceAgent(configured, { targetAgent, threadId: "original-full-session" }), /Multiple backend configurations/);
    for (const original of configured.agents) {
      assert.deepEqual(resolveInstanceAgent(configured, { targetAgent, agentId: original.agentId,
        threadId: "original-full-session" }), original);
    }
    const unconfigured = resolveInstanceAgent(config, { targetAgent, threadId: "original-full-session" });
    assert.equal(unconfigured.provider, targetAgent);
    assert.equal(unconfigured.workspace, config.defaultWorkspace);
  }
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

test("optional backend configurations have no arbitrary 128-entry limit and retain explicit selection",()=>{
 const agents=Array.from({length:256},(_,index)=>({agentId:`backend-${index}`,provider:"codex-desktop",workspace:config.defaultWorkspace,name:`Backend ${index}`}));
 const existing={...config,agents};
 const next=configureInstanceAgent(existing,{agentId:"new-backend",provider:"codex-desktop",name:"New backend"});
 assert.equal(next.agents.length,257);
 assert.deepEqual(next.agents.slice(0,256),agents);
 assert.equal(existing.agents.length,256);
 assert.equal(resolveInstanceAgent(next,{targetAgent:"codex-desktop",threadId:"exact-session",agentId:"new-backend"}).agentId,"new-backend");
 assert.throws(()=>resolveInstanceAgent(next,{targetAgent:"codex-desktop",threadId:"exact-session"}),/explicitly select/);
 const edited=configureInstanceAgent(next,{agentId:"backend-128",name:"Updated"});
 assert.equal(edited.agents.length,257);
 assert.equal(edited.agents[128].name,"Updated");
 assert.throws(()=>configureInstanceAgent(next,{agentId:"invalid id",provider:"codex-desktop"}),/Invalid Agent identity/);
 assert.throws(()=>configureInstanceAgent(next,{agentId:"new-backend",provider:"dsh"}),/changing providers/);
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
