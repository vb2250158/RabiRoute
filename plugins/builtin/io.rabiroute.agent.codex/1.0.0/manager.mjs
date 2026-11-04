import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { definePlugin, ownAgentAdapter, parseAgentAdapterPackageDescriptor } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./manager-runtime.mjs";

export const activate = definePlugin({
  async activate(context) {
    const hostService = context.services.require("host.agent-adapters@1");
    const host = hostService.forActivation?.(context.config) ?? hostService;
    let descriptor;
    try { descriptor = JSON.parse(await fs.readFile(new URL("./agent-adapter.json", import.meta.url), "utf8")); }
    catch { throw new Error("Agent package descriptor could not be read."); }
    descriptor = parseAgentAdapterPackageDescriptor(descriptor);
    await host.prepareModules(hostModules);
    let owned;
    let disposal;
    const disposeOnce = () => disposal ??= Promise.resolve().then(() => owned?.dispose?.());
    try {
      const implementation = createImplementation(host);
      owned = implementation.createManager({
      manifest: descriptor.manifest,
      capability: descriptor.capability,
      scannerEntry: fileURLToPath(new URL("./workers/scan.mjs", import.meta.url)),
      scannerExport: "scanCodexAgentAdapter",
      runtimeLayout: {
        packageRoot: host.environment?.RABIROUTE_PACKAGE_ROOT ?? host.manager.packageRoot,
        stateRoot: host.environment?.RABIROUTE_STATE_ROOT ?? host.manager.rootDir
      },
      host: host.manager
    }, descriptor, context.lifecycle.signal);
    const provider = ownAgentAdapter(context, {
      ...descriptor,
      operations: owned.operations,
      serviceEndpoint: owned.serviceEndpoint,
      deviceEndpoint: owned.deviceEndpoint,
      dispose: disposeOnce
    });
    context.contributions.register({ kind: "agent-adapter-settings", id: "agent.codex.card.v1", value: {
  "surface": "route.adapters",
  "hosts": [
    "web"
  ],
  "slot": "codex",
  "agentType": "codex",
  "capability": "agent.adapter.codex@1",
  "rendererId": "agent.codex.card.v1",
  "schemaId": "agent.codex.route.v1",
  "readCommandId": "agent.codex.route.read",
  "writeCommandId": "agent.codex.route.write",
  "order": 0,
  "catalog": {
    "title": "Codex（ChatGPT 中的编码 Agent）",
    "note": "消息由桌面任务执行并实时显示",
    "icon": "mdi-monitor-dashboard",
    "order": 0,
    "location": "local",
    "hasCwd": true,
    "hasThread": true
  }
} });
    context.effects.add(async () => {
      const definitions = (owned.apiOperations?.(provider.invoke.bind(provider)) ?? []).map(definition => ({
        ...definition,
        handler: input => provider.runAcceptedWork(() => definition.handler(input))
      }));
      const registration = await host.manager.registerOperations(context.identity.instanceId, definitions, context.lifecycle.signal);
      return () => registration.dispose();
    }, "register owned Agent management operations");
    context.publication.add({
      publish: () => owned.start?.(),
      rollback: () => owned.unpublish?.(),
      retire: () => owned.unpublish?.()
    }, "publish owned Agent subscriptions");
    } catch (error) {
      try { await disposeOnce(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Agent preparation and cleanup failed."); }
      throw error;
    }
  }
}).activate;
