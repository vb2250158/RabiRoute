import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ComputerService } from "../../apps/rabi-agent/lib/computer-service.mjs";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate, PluginModule } from "../plugin-kernel/types.js";
import type { DesktopNativeService } from "@rabiroute/plugin-sdk";
import { LanAgentReleaseStore } from "./lanAgentReleaseStore.js";

/** Controlled native protocol only: real signatures/store/kernel publication, no physical input. */
test("plugin publication adopts only imported desktop resources and a reopened service restores its selection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-desktop-publication-"));
  const agent = path.join(root,"agent");fs.mkdirSync(path.join(agent,"dist/native"),{recursive:true});
  fs.writeFileSync(path.join(agent,"rabi-agent.mjs"),"export {};\n");
  const store = new LanAgentReleaseStore({rootDir:root,agentRoot:agent});
  const importVersion = (version:string) => {
    fs.writeFileSync(path.join(agent,"package.json"),JSON.stringify({version}));
    fs.writeFileSync(path.join(agent,"dist/native/RabiAgent.Computer.exe"),"controlled bytes "+version);
    return store.importRelease(agent).releaseDigest;
  };
  const first=importVersion("0.1.1"), second=importVersion("0.1.2");
  const commonBefore=store.publication();
  const makeService = () => new ComputerService({
    resolveDesktopRelease:async reference=>store.desktopResourceRelease(String(reference)),
    restoreDesktopRelease:async()=>{const s=store.desktopResourceSelection();return {revision:s.revision,...(s.digest?{reference:s.digest}:{})};},
    commitDesktopRelease:async(release,revision)=>store.selectDesktopResourceRelease(release.digest!,revision),
    nativeFactory:()=>Object.assign(new EventEmitter(),{
      async request(action:string){return action==="capabilities"?{protocolVersion:2,trackingAvailable:true}:{state:"completed"};},async close(){}
    })
  });
  const service=makeService();
  const port:DesktopNativeService={status:()=>service.desktopReleaseStatus(),prepare:digest=>service.prepareDesktopRelease(digest),activate:(prepared,revision)=>service.activateDesktopRelease(prepared,revision),discard:prepared=>service.discardDesktopRelease(prepared)};
  const modules=new WeakMap<PluginCandidate,PluginModule>();
  const runtime=new GenerationRuntime({host:"manager",hostServices:[{capability:"host.manager.desktop-native@1",value:port}],executor:{prepare:async candidate=>modules.get(candidate)!}});
  const candidate=(digest:string,version:string):PluginCandidate=>{
    const item:PluginCandidate={instanceId:"desktop-resources",revision:digest,config:{},entry:{execution:"in_process",path:"controlled.mjs"},
      manifest:{schemaVersion:2,id:"io.test.desktop-resources",version,entries:{manager:{execution:"in_process",module:"./manager.mjs"}},provides:[],requires:["host.manager.desktop-native@1"],optional:[],permissions:[]}};
    modules.set(item,{async activate(context){
      const desktop=context.services.require<DesktopNativeService>("host.manager.desktop-native@1");
      const current=await desktop.status();const prepared=await desktop.prepare(digest);
      context.effects.adopt(()=>desktop.discard(prepared));
      context.publication.add({publish(){},rollback(){},async afterPublish(){await desktop.activate(prepared,current.revision);}});
    }});return item;
  };
  try {
    await runtime.switch([candidate(first,"0.1.1")]);
    assert.equal((await service.desktopReleaseStatus()).revision,1);
    const originalComputer=Reflect.get(service,"control");
    await runtime.switch([candidate(second,"0.1.2")]);
    assert.equal(Reflect.get(service,"control"),originalComputer);assert.equal(store.desktopResourceSelection().digest,second);
    assert.equal((await service.desktopReleaseStatus()).revision,2);
    assert.deepEqual(store.publication(),commonBefore);assert.equal(store.selectedReleaseDigest("unmodified-node"),undefined);
    await runtime.switch([candidate(first,"0.1.1")]);
    assert.equal(store.desktopResourceSelection().digest,first);
    assert.equal((await service.desktopReleaseStatus()).revision,3);
    await runtime.dispose();await service.stop();
    const reopened=makeService();
    try{assert.equal((await reopened.desktopReleaseStatus()).revision,3);assert.equal((await reopened.desktopReleaseStatus()).release && store.desktopResourceSelection().digest,first);}
    finally{await reopened.stop();}
  } finally {await runtime.dispose();await service.stop();fs.rmSync(root,{recursive:true,force:true});}
});
