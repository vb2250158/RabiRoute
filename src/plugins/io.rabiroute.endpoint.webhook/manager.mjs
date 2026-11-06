import { definePlugin, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({ activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  ownMessageEndpointScan(context, { type: "webhook", label: "通用 Webhook", maturity: "experimental", mode: "immediate", async scan() {
    const routes = host.routeSnapshots("webhook");
    const current = routes.map(route => route.status.messageAdapters?.["webhook"]);
    const ready = current.some(status => status && ["running", "ready"].includes(status.status));
    return { type: "webhook", label: "通用 Webhook", maturity: "experimental", installed: routes.length > 0, endpoints: routes.map(route => route.callback).filter(Boolean), requirements: [{ id: "route", label: "已配置消息端", required: true, ok: routes.length > 0 }, { id: "runtime", label: "入口运行状态", required: true, ok: ready, detail: current.map(status => status?.message).filter(Boolean).join("；") }], warnings: [] };
  } });
  context.services.provide("endpoint.webhook@1", Object.freeze({ type: "webhook", instanceId: context.identity.instanceId }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-webhook-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "通用 Webhook"
    },
    "endpointType": "webhook",
    "catalog": {
      "title": "通用 Webhook",
      "note": "通过 HTTP 接入自定义消息",
      "icon": "mdi-webhook",
      "group": {
        "id": "devices",
        "title": "设备与自定义接入",
        "note": "连接手机、设备及自定义系统",
        "order": 20
      },
      "order": 30
    },
    "rendererId": "endpoint.webhook.card.v1",
    "schemaId": "endpoint.webhook.route.v1",
    "readCommandId": "endpoint.webhook.route.read",
    "writeCommandId": "endpoint.webhook.route.write",
    "icon": "mdi-webhook",
    "slot": "webhook",
    "hosts": [
      "web"
    ],
    "order": 30
  }
});
} }).activate;
