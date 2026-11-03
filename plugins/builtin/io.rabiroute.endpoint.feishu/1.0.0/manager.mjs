import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "feishu", operations: egress });
  ownMessageEndpointScan(context, { type: "feishu", label: "飞书", maturity: "experimental", mode: "immediate", async scan() {
    const routes = host.routeSnapshots("feishu");
    const current = routes.map(route => route.status.messageAdapters?.["feishu"]);
    const ready = current.some(status => status && ["running", "ready"].includes(status.status));
    return { type: "feishu", label: "飞书", maturity: "experimental", installed: routes.length > 0, endpoints: routes.map(route => route.callback).filter(Boolean), requirements: [{ id: "route", label: "已配置消息端", required: true, ok: routes.length > 0 }, { id: "runtime", label: "入口运行状态", required: true, ok: ready, detail: current.map(status => status?.message).filter(Boolean).join("；") }], warnings: [] };
  } });
  context.services.provide("endpoint.feishu@1", Object.freeze({ type: "feishu", instanceId: context.identity.instanceId }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-feishu-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "飞书"
    },
    "endpointType": "feishu",
    "catalog": {
      "title": "飞书",
      "note": "连接飞书应用消息",
      "icon": "mdi-message-text",
      "group": {
        "id": "chat",
        "title": "聊天平台",
        "note": "连接群聊、私聊和协作平台",
        "order": 10
      },
      "order": 40
    },
    "rendererId": "endpoint.feishu.card.v1",
    "schemaId": "endpoint.feishu.route.v1",
    "readCommandId": "endpoint.feishu.route.read",
    "writeCommandId": "endpoint.feishu.route.write",
    "icon": "mdi-message-text",
    "slot": "feishu",
    "hosts": [
      "web"
    ],
    "order": 40
  }
});
} }).activate;
