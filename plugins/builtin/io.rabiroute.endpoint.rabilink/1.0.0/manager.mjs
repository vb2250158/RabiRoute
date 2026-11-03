import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan, ownPluginAcceptedWork } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./manager-runtime.mjs";
export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "rabilink", operations: egress });
  await host.prepareModules(hostModules);
  const implementation = createImplementation(host);
  const work = ownPluginAcceptedWork(context, "accepted mobile message deliveries");
  const currentOwner = implementation.createMobilePluginOwner({ rootDir: host.manager.rootDir,
    assertCurrent: () => context.lifecycle.signal.throwIfAborted(),
    connection: () => {
      const connection = context.services.optional("manager.rabilink-relay@1")?.connection;
      if (!connection) throw Object.assign(new Error("MOBILE_TRANSPORT_UNAVAILABLE"), { code: "MOBILE_TRANSPORT_UNAVAILABLE", statusCode: 503 });
      return connection;
    }
  });
  context.effects.add(async () => {
    const registration = await host.operations.registerOperationsAsync(context.identity.instanceId, implementation.createRabiLinkMobileOperations(currentOwner), context.lifecycle.signal);
    return () => registration.dispose();
  }, "own mobile configuration, status and proof operations");
  ownMessageEndpointScan(context, { type: "rabilink", label: "手机 / RabiLink", maturity: "experimental", mode: "immediate", async scan() {
    const routes = host.routeSnapshots("rabilink");
    const current = routes.map(route => route.status.messageAdapters?.["rabilink"]);
    const ready = current.some(status => status && ["running", "ready"].includes(status.status));
    return { type: "rabilink", label: "手机 / RabiLink", maturity: "experimental", installed: routes.length > 0, endpoints: routes.map(route => route.callback).filter(Boolean), requirements: [{ id: "route", label: "已配置消息端", required: true, ok: routes.length > 0 }, { id: "runtime", label: "入口运行状态", required: true, ok: ready, detail: current.map(status => status?.message).filter(Boolean).join("；") }], warnings: [] };
  } });
  context.services.provide("endpoint.rabilink@1", Object.freeze({ type: "rabilink", instanceId: context.identity.instanceId, runAcceptedWork: work.runAcceptedWork }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-rabilink-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "手机 / RabiLink"
    },
    "endpointType": "rabilink",
    "catalog": {
      "title": "手机 / RabiLink",
      "note": "连接 RabiLink 手机及 Relay 消息",
      "icon": "mdi-cellphone",
      "group": {
        "id": "devices",
        "title": "设备与自定义接入",
        "note": "连接手机、设备及自定义系统",
        "order": 20
      },
      "order": 10
    },
    "rendererId": "endpoint.rabilink.card.v1",
    "schemaId": "endpoint.rabilink.route.v1",
    "readCommandId": "endpoint.rabilink.route.read",
    "writeCommandId": "endpoint.rabilink.route.write",
    "icon": "mdi-cellphone",
    "slot": "rabilink",
    "hosts": [
      "web"
    ],
    "order": 10
  }
});
} }).activate;
