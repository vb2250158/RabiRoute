import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "wecom", operations: egress, dispose: () => egress.disposeWeComClients() });
  ownMessageEndpointScan(context, { type: "wecom", label: "企业微信", maturity: "experimental", mode: "immediate", async scan() {
    const routes = host.routeSnapshots("wecom");
    const current = routes.map(route => route.status.messageAdapters?.["wecom"]);
    const ready = current.some(status => status && ["running", "ready"].includes(status.status));
    return { type: "wecom", label: "企业微信", maturity: "experimental", installed: routes.length > 0, endpoints: routes.map(route => route.callback).filter(Boolean), requirements: [{ id: "route", label: "已配置消息端", required: true, ok: routes.length > 0 }, { id: "runtime", label: "入口运行状态", required: true, ok: ready, detail: current.map(status => status?.message).filter(Boolean).join("；") }], warnings: [] };
  } });
  context.services.provide("endpoint.wecom@1", Object.freeze({ type: "wecom", instanceId: context.identity.instanceId }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-wecom-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "企业微信"
    },
    "endpointType": "wecom",
    "catalog": {
      "title": "企业微信",
      "note": "连接企业微信智能机器人",
      "icon": "mdi-office-building",
      "group": {
        "id": "chat",
        "title": "聊天平台",
        "note": "连接群聊、私聊和协作平台",
        "order": 10
      },
      "order": 30
    },
    "rendererId": "endpoint.wecom.card.v1",
    "schemaId": "endpoint.wecom.route.v1",
    "readCommandId": "endpoint.wecom.route.read",
    "writeCommandId": "endpoint.wecom.route.write",
    "icon": "mdi-office-building",
    "slot": "wecom",
    "hosts": [
      "web"
    ],
    "order": 30
  }
});
} }).activate;
