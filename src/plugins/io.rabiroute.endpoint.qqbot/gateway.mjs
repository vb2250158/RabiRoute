import { definePlugin, ownMessageEndpoint, ownMessageEndpointEgress } from "@rabiroute/plugin-sdk";
import { createEndpoint, hostModules } from "./runtime.mjs";
import { createImplementation, hostModules as egressModules } from "./manager-runtime.mjs";

export const activate = definePlugin({ async activate(context) {
  const runtime = context.services.require("host.message-endpoints@1");
  // Account and port come from the Route snapshot, including on first boot.
  const host = runtime.forActivation({ ...context.config, __routeInheritedFields: [] });
  await host.prepareModules(hostModules);
  await host.prepareModules(egressModules);
  const implementation = createImplementation(host);
  const { config, runtimeLayout } = host.module("config");
  const accounts = implementation.createBotAccounts(runtimeLayout.stateRoot);
  const operations = implementation.createBotEgress(accounts, implementation.createBotApi(), source => {
    context.lifecycle.signal.throwIfAborted();
    if (source.gatewayId !== process.env.GATEWAY_ID || source.instanceId !== config.qqbotAccountId) {
      throw new Error("当前 Route 已更换 QQ 机器人。");
    }
  });
  ownMessageEndpointEgress(context, { type: "qqbot", operations });
  context.services.provide("endpoint.qqbot@1", Object.freeze({ type: "qqbot" }));
  ownMessageEndpoint(context, createEndpoint(host));
} }).activate;
