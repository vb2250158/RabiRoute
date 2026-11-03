import { definePlugin, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
export const activate = definePlugin({ activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  ownMessageEndpointScan(context, { type: "heartbeat", label: "定时触发", maturity: "verified", mode: "immediate", async scan() {
    const routes = host.routeSnapshots("heartbeat");
    const current = routes.map(route => route.status.messageAdapters?.["heartbeat"]);
    const ready = current.some(status => status && ["running", "ready"].includes(status.status));
    return { type: "heartbeat", label: "定时触发", maturity: "verified", installed: routes.length > 0, endpoints: routes.map(route => route.callback).filter(Boolean), requirements: [{ id: "route", label: "已配置消息端", required: true, ok: routes.length > 0 }, { id: "runtime", label: "入口运行状态", required: true, ok: ready, detail: current.map(status => status?.message).filter(Boolean).join("；") }], warnings: [] };
  } });
  context.services.provide("endpoint.heartbeat@1", Object.freeze({ type: "heartbeat", instanceId: context.identity.instanceId }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-heartbeat-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "定时触发"
    },
    "endpointType": "heartbeat",
    "catalog": {
      "title": "定时触发",
      "note": "按时间安排触发人格任务",
      "icon": "mdi-timer-outline",
      "group": {
        "id": "local",
        "title": "本机与任务",
        "note": "连接本地输入和主动任务",
        "order": 30
      },
      "order": 20
    },
    "rendererId": "endpoint.heartbeat.card.v1",
    "schemaId": "endpoint.heartbeat.route.v1",
    "readCommandId": "endpoint.heartbeat.route.read",
    "writeCommandId": "endpoint.heartbeat.route.write",
    "icon": "mdi-timer-outline",
    "slot": "heartbeat",
    "hosts": [
      "web"
    ],
    "order": 20
  }
});
} }).activate;
