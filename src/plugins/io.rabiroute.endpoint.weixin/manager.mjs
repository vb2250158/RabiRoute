import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";

const empty = { type: "object", additionalProperties: false };
const string = { type: "string", minLength: 1, maxLength: 256 };
const opaque = { type: "object", additionalProperties: true };
const root = "/api/message/weixin/routes/:routeId";

function sessionOperations(manager, methods, signal) {
  const actions = [
    { id: "login", title: "生成微信机器人登录二维码", fields: { mode: { enum: ["owner", "other"] } },
      run: (dir, body) => methods.requestWeixinLogin(dir, new Date(), body.mode) },
    { id: "pin", title: "提交微信机器人绑定验证码", fields: { attemptId: string, pin: { type: "string", pattern: "^[0-9]{1,16}$" } },
      run: (dir, body) => methods.submitWeixinPin(dir, body.attemptId, body.pin) },
    { id: "logout", title: "退出微信机器人登录", fields: {}, run: dir => methods.requestWeixinLogout(dir) },
    { id: "typing", title: "设置微信机器人输入状态", fields: { sessionId: string, typing: { type: "boolean" } },
      run: (dir, body, input) => methods.setWeixinTyping(dir, body.sessionId, body.typing,
        input.signal ? AbortSignal.any([signal, input.signal]) : signal) }
  ];
  return actions.map(({ id, title, fields, run }) => ({
    contract: {
      operationId: "manager.weixin." + id, contractVersion: "1.0.0", method: "POST",
      pathTemplate: root + "/" + id, transport: "http", exposure: "public", description: title,
      request: { path: { ...empty, properties: { routeId: string }, required: ["routeId"] },
        headers: opaque, query: empty, body: { kind: "json", schema: { ...empty, properties: fields, required: Object.keys(fields) },
          maxBytes: 4096, ...(id === "logout" ? { emptyValue: {} } : {}) } },
      responses: { "200": { mediaType: "application/json", schema: opaque }, "202": { mediaType: "application/json", schema: opaque },
        default: { mediaType: "application/json", schema: opaque } },
      effects: { mode: id === "typing" ? "platform-presence" : "credential-management", description: title },
      recovery: { strategy: "read-current-state", description: "重新读取原 Route 的微信机器人状态。" },
      validators: [{ id: "weixin-route", description: "当前 Route 必须启用微信机器人。" }]
    },
    discovery: { title, summary: title, tags: ["微信机器人", "Weixin", "iLink"], provider: "weixin" },
    async handler(input) {
      const fail = (status, message) => ({ status, body: { code: -1, message } });
      if (!manager.access(input.request, input.url)) return fail(403, "当前连接无权管理微信机器人。");
      if (signal.aborted || manager.readOnly) return fail(503, "微信机器人设置暂不可写。");
      const route = manager.readRoute(input.path.routeId);
      const dir = manager.routeDataDir?.(input.path.routeId);
      if (!dir || !route || route.enabled === false || !route.messageAdapters?.includes("weixin")
        || route.messageAdaptersDisabled?.includes("weixin")) return fail(404, "此 Route 未启用微信机器人。");
      if (id === "typing" && route.messageAdapterPolicies?.weixin?.outputEnabled === false) return fail(403, "此 Route 已关闭微信机器人的外发。");
      if (id === "pin") {
        const state = manager.readGatewayStatus(route).messageAdapters?.weixin;
        if (state?.loginAttemptId !== input.body.attemptId || !String(state?.qrStatus ?? "").includes("need_verifycode")) {
          return fail(409, "二维码已更新，请在当前卡片重新填写验证码。");
        }
      }
      try { await run(dir, input.body, input); }
      catch (error) { return fail(502, error instanceof Error ? error.message : "微信机器人操作失败。"); }
      return { status: id === "typing" ? 200 : 202, body: { code: 0, data: { routeId: route.id } } };
    }
  }));
}

export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "weixin", operations: egress });
  context.effects.add(async () => {
    const registration = await host.manager.routes.registerOperationsAsync(context.identity.instanceId,
      sessionOperations(host.manager, egress, context.lifecycle.signal), context.lifecycle.signal);
    return () => registration.dispose();
  }, "Weixin robot operations");
  ownMessageEndpointScan(context, { type: "weixin", label: "微信机器人", maturity: "experimental", mode: "immediate", async scan() {
    const routes = host.routeSnapshots("weixin");
    const current = routes.map(route => route.status.messageAdapters?.["weixin"]);
    const ready = current.some(status => status && ["running", "ready"].includes(status.status));
    return { type: "weixin", label: "微信机器人", maturity: "experimental", installed: routes.length > 0, endpoints: routes.map(route => route.callback).filter(Boolean), requirements: [{ id: "route", label: "已配置消息端", required: true, ok: routes.length > 0 }, { id: "runtime", label: "入口运行状态", required: true, ok: ready, detail: current.map(status => status?.message).filter(Boolean).join("；") }], warnings: [] };
  } });
  context.services.provide("endpoint.weixin@1", Object.freeze({ type: "weixin", instanceId: context.identity.instanceId }));
  context.contributions.register({
  "kind": "message-endpoint-settings",
  "id": "endpoint-weixin-card",
  "value": {
    "surface": "route.adapters",
    "label": {
      "fallback": "微信机器人"
    },
    "endpointType": "weixin",
    "catalog": {
      "title": "微信机器人",
      "note": "通过腾讯 iLink 收发微信消息",
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
