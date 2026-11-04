import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { RabiCordisHost } from "./cordisHost.js";
import { mountGatewayEndpointPlugins } from "./gatewayEndpointPlugins.js";
import { GenerationRuntime, PluginPackageCatalog, loadPluginProfile } from "../plugin-kernel/index.js";
import { createAgentAdapterHostPorts } from "./agentAdapterHostPorts.js";

test("a malformed physical Codex descriptor never constructs its IPC client or leaks exit cleanup", { timeout: 90_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-codex-metadata-"));
    const host = new RabiCordisHost();
    try {
        // @ts-expect-error JavaScript package builder is outside src.
        const { buildPluginPackages } = await import("../../scripts/build-plugin-packages.mjs");
        const built = await buildPluginPackages(process.cwd(), { packages: ["io.rabiroute.agent.codex"], outputDirectory: path.join(root, "built") });
        const descriptorFile = path.join(built.packagesRoot, "io.rabiroute.agent.codex/1.0.0/agent-adapter.json");
        const bytes = await fs.readFile(descriptorFile), descriptor = JSON.parse(bytes.toString("utf8"));
        descriptor.manifest.transport = null;
        await fs.writeFile(descriptorFile, JSON.stringify(descriptor));
        const profilePath = path.join(root, "profile.json");
        await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "agent:codex", package: "io.rabiroute.agent.codex", version: "1.0.0", enabled: true, config: {}, grants: [] }] }));
        const count = process.listenerCount("exit");
        const runtime = await mountGatewayEndpointPlugins(host, { profilePath, settingsRoot: path.join(root, "settings"), packageRoots: [built.packagesRoot], runtimeRoot: path.join(root, "runtime"), adapterTypes: [], watch: false });
        assert.equal(runtime.current().records[0].status, "failed");
        assert.equal(process.listenerCount("exit"), count);
        for (let attempt = 0; attempt < 3; attempt++) {
            descriptor.manifest.label = `Malformed Codex ${attempt}`;
            await fs.writeFile(descriptorFile, JSON.stringify(descriptor)); await runtime.reconcile();
            assert.equal(process.listenerCount("exit"), count, "Invalid metadata must fail before the platform IIFE registers cleanup.");
        }
        await fs.writeFile(descriptorFile, bytes); await runtime.reconcile();
        assert.equal(runtime.current().records[0].status, "active");
        assert.equal(process.listenerCount("exit"), count + 1, "One valid activation owns its original IPC client cleanup.");
        await runtime.unmount();
        assert.equal(process.listenerCount("exit"), count, "Native retirement releases that exact client cleanup without stopping Desktop.");
    } finally {
        await host.dispose(); await fs.rm(root, { recursive: true, force: true });
    }
});

test("physical Codex entry catch and native rollback join the same one-shot disposer", { timeout: 90_000 }, async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"native-codex-rollback-"));
    const catalog=new PluginPackageCatalog([path.join(root,"built/packages")]);
    const remove=process.removeListener;
    let cleanupCalls=0;
    process.removeListener=function(event,listener){if(event==="exit"&&listener.name==="closeDesktopBridge")cleanupCalls++;return remove.call(this,event,listener);};
    const kernel=new GenerationRuntime({host:"gateway",hostServices:[{capability:"host.agent-adapters@1",value:createAgentAdapterHostPorts()}],executor:{async prepare(candidate){
        const module=await import(pathToFileURL(candidate.entry.path).href);
        return {activate(context){return module.activate({...context,contributions:{register(){throw new Error("Fixture contribution publication failed");}}});}};
    }}});
    try{
        // @ts-expect-error JavaScript package builder is outside src.
        const {buildPluginPackages}=await import("../../scripts/build-plugin-packages.mjs");
        await buildPluginPackages(process.cwd(),{packages:["io.rabiroute.agent.codex"],outputDirectory:path.join(root,"built")});
        const profilePath=path.join(root,"profile.json");await fs.writeFile(profilePath,JSON.stringify({schemaVersion:2,readyRequires:[],instances:[{id:"agent:codex",package:"io.rabiroute.agent.codex",version:"1.0.0",enabled:true,config:{},grants:[]}]}));
        const loaded=await loadPluginProfile({profilePath,packageCatalog:catalog,runtimeRoot:path.join(root,"runtime"),host:"gateway"});
        const count=process.listenerCount("exit");await kernel.switch(loaded.candidates);
        assert.equal(kernel.current().records[0].status,"failed");
        assert.equal(cleanupCalls,1,"Entry catch and SDK cleanup must share the original disposer promise.");
        assert.equal(process.listenerCount("exit"),count);
        await kernel.shutdown();assert.equal(cleanupCalls,1);
    }finally{await kernel.shutdown();await catalog.dispose();process.removeListener=remove;await fs.rm(root,{recursive:true,force:true});}
});
