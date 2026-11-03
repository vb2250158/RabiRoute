import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpoint } from "@rabiroute/plugin-sdk";
import { createEndpoint, hostModules } from "./runtime.mjs";
export const activate = definePlugin({ async activate(context) {
  const runtime = context.services.require("host.message-endpoints@1");
  const host = runtime.forActivation(context.config);
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "feishu", operations: egress });
  await host.prepareModules(hostModules);
  const endpoint = createEndpoint(host);
  context.services.provide("endpoint.feishu@1", Object.freeze({ type: "feishu" }));
  ownMessageEndpoint(context, endpoint);
} }).activate;
