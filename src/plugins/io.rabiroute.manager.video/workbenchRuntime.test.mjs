import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PublicationScope} from "@rabiroute/plugin-sdk";
import {prepareVideoEntryFixture,importVideoHostTestModule} from "./entry.fixture.mjs";
const {ProcessLeaseRegistry}=await importVideoHostTestModule("runtime/processLeaseRegistry");
const {ManagerPluginRouteRegistry}=await importVideoHostTestModule("manager/managerPluginRouteRegistry");
const {EffectScope}=await importVideoHostTestModule("plugin-kernel/effectScope");
test("native Workbench receipts join tree exit, Node close, exit code and stdout",{timeout:20000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"workbench-native-")),leases=new ProcessLeaseRegistry(undefined,{terminationTimeoutMs:3000}),routes=new ManagerPluginRouteRegistry();let context;
  const fixture=await prepareVideoEntryFixture(t,{rootDir:root,onOperations(value){context=value;}}),effects=new EffectScope(),publication=new PublicationScope(effects);
  t.after(async()=>{await effects.dispose();await leases.disposeAll();await fs.rm(root,{recursive:true,force:true});});
  const services={"host.manager.video@2":{...fixture.shared,managerPluginProcessLeases:leases},"host.manager.http@1":{publishManagerEvent(){},readJsonBody:async()=>({})},"host.manager.operations@1":{registerOperationsAsync:(definitions,signal)=>routes.registerOperationsAsync("manager:video",definitions,signal),registerHttpProxies:definitions=>routes.registerHttpProxies("manager:video",definitions)}};
  await fixture.activate({identity:{applicationGenerationId:"test-generation",managerInstanceId:"test-manager",activationId:"test-activation",instanceId:"manager:video",revision:"test-revision"},lifecycle:{signal:effects.signal()},services:{require:key=>services[key],provide(){}},contributions:{register(){}},effects,publication});
  await effects.commit();publication.publish();publication.seal()();await publication.afterPublish(Promise.resolve());
  for(const exitCode of [0,7]) {
    let output="";const handle=context.runtime.launchWorkbenchProcess({attemptId:`native-exit-${exitCode}`,executable:process.execPath,argv:["-e",`console.log('已完整退出');process.exit(${exitCode})`],cwd:root,env:process.env,timeoutMs:10000},async(_stream,text)=>{await new Promise(resolve=>setTimeout(resolve,20));output+=text;});
    const receipt=await handle.settled;assert.equal(receipt.exitCode,exitCode);assert.equal(receipt.terminated,true);assert.match(output,/已完整退出/);assert.equal(leases.list().length,0);
  }
});
