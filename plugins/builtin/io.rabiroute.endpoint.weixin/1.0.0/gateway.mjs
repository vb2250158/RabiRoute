import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpoint } from "@rabiroute/plugin-sdk";
import { createEndpoint, hostModules } from "./runtime.mjs";
export const activate = definePlugin({ async activate(context) {
  const runtime = context.services.require("host.message-endpoints@1");
  const host = runtime.forActivation(context.config);
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "weixin", operations: egress });
  await host.prepareModules(hostModules);
  const endpoint = createEndpoint(host);
  context.services.provide("endpoint.weixin@1", Object.freeze({ type: "weixin" }));
  ownMessageEndpoint(context, endpoint);
} }).activate;
