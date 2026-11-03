import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "weixin", operations: egress });
  ownMessageEndpointScan(context, { type: "weixin", label: "个人微信", maturity: "experimental", mode: "immediate", async scan() {
    const routes = host.routeSnapshots("weixin");
    const current = routes.map(route => route.status.messageAdapters?.["weixin"]);
    const ready = current.some(status => status && ["running", "ready"].includes(status.status));
    return { type: "weixin", label: "个人微信", maturity: "experimental", installed: routes.length > 0, endpoints: routes.map(route => route.callback).filter(Boolean), requirements: [{ id: "route", label: "已配置消息端", required: true, ok: routes.length > 0 }, { id: "runtime", label: "入口运行状态", required: true, ok: ready, detail: current.map(status => status?.message).filter(Boolean).join("；") }], warnings: [] };
  } });
  context.services.provide("endpoint.weixin@1", Object.freeze({ type: "weixin", instanceId: context.identity.instanceId }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-weixin-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "个人微信"
    },
    "endpointType": "weixin",
    "catalog": {
      "title": "个人微信",
      "note": "连接个人微信消息",
      "icon": "mdi-wechat",
      "group": {
        "id": "chat",
        "title": "聊天平台",
        "note": "连接群聊、私聊和协作平台",
        "order": 10
      },
      "order": 20
    },
    "rendererId": "endpoint.weixin.card.v1",
    "schemaId": "endpoint.weixin.route.v1",
    "readCommandId": "endpoint.weixin.route.read",
    "writeCommandId": "endpoint.weixin.route.write",
    "icon": "mdi-wechat",
    "slot": "weixin",
    "hosts": [
      "web"
    ],
    "order": 20
  }
});
} }).activate;
