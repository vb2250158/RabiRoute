import { definePlugin, ownMessageEndpointEgress, ownMessageEndpointScan } from "@rabiroute/plugin-sdk";
import { createImplementation, hostModules } from "./manager-runtime.mjs";

const label = "QQ 官方机器人";

export const activate = definePlugin({ async activate(context) {
  const host = context.services.require("host.message-endpoints@1");
  const manager = host.manager;
  await host.prepareModules(hostModules);
  const implementation = createImplementation(host);
  const accounts = implementation.createBotAccounts(manager.rootDir);
  const api = implementation.createBotApi();
  context.services.provide("endpoint.qqbot@1", Object.freeze({ type: "qqbot" }));
  const operations = implementation.createBotEgress(accounts, api, source => {
    const route = manager.readRoute(source.gatewayId);
    if (!route || route.enabled === false || route.qqbotAccountId !== source.instanceId
      || !route.messageAdapters?.includes("qqbot") || route.messageAdaptersDisabled?.includes("qqbot")
      || route.messageAdapterPolicies?.qqbot?.outputEnabled === false
      || (route.messageAdapterPolicies?.qqbot?.supportedOutputs && !route.messageAdapterPolicies.qqbot.supportedOutputs.includes("text"))) {
      throw new Error("当前 Route 已更换机器人或关闭文本发送。");
    }
  });
  const sourceReply = implementation.createBotSourceReply(manager.readRoute, operations.reply);
  ownMessageEndpointEgress(context, { type: "qqbot", operations: { ...operations, sendSourceReplyVariant: sourceReply.sendSourceReplyVariant },
    sendVariants: [sourceReply.variant] });
  ownMessageEndpointScan(context, { type: "qqbot", label, maturity: "experimental", mode: "immediate", scan() {
    const saved = accounts.list();
    const routes = host.routeSnapshots("qqbot");
    const endpoints = routes.flatMap(({ definition }) => {
      try {
        const listener = manager.readListener(definition.id, "qqbot.callback");
        listener?.assertCurrent();
        return listener ? [{ label: definition.name, url: `http://127.0.0.1:${listener.address.port}/qqbot`, healthy: true }] : [];
      } catch { return []; }
    });
    return { type: "qqbot", label, maturity: "experimental", installed: true, endpoints,
      requirements: [
        { id: "auth", label: "QQ 开放平台机器人凭据", required: true, ok: saved.some(account => account.state === "connected"), url: "https://q.qq.com/" },
        { id: "callback", label: "HTTPS 回调或 WebSocket", required: true,
          ok: endpoints.length > 0 || routes.some(({ definition }) => definition.qqbotTransport === "websocket" && definition.qqbotAccountId),
          detail: "回调方式需要公网 HTTPS。WebSocket 实际连接状态见 Route 运行日志。" }
      ], warnings: [] };
  } });
  context.effects.add(async () => {
    const registration = await manager.routes.registerOperationsAsync(context.identity.instanceId,
      [...implementation.createBotOperations(accounts, api, manager, context.lifecycle.signal),
        ...implementation.createBotPlatformOperations(accounts, api, manager, context.lifecycle.signal)], context.lifecycle.signal);
    return () => registration.dispose();
  }, "QQ bot account operations");
  context.contributions.register({ kind: "message-endpoint-settings", id: "endpoint-qqbot-card", value: {
    surface: "route.adapters", endpointType: "qqbot", label: { fallback: label }, slot: "qqbot", hosts: ["web"],
    catalog: { title: label, note: "接收 QQ 消息和平台事件，调用官方机器人接口", icon: "mdi-robot-outline", order: 15,
      group: { id: "chat", title: "聊天平台", note: "连接群聊、私聊和协作平台", order: 10 } },
    rendererId: "endpoint.qqbot.card.v1", schemaId: "endpoint.qqbot.route.v1",
    readCommandId: "endpoint.qqbot.route.read", writeCommandId: "endpoint.qqbot.route.write", icon: "mdi-robot-outline", order: 15
  } });
} }).activate;
