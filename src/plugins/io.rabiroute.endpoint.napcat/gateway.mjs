import { createImplementation as createEgress, hostModules as egressModules } from "./egress-runtime.mjs";
import { definePlugin, ownMessageEndpointEgress, ownMessageEndpoint } from "@rabiroute/plugin-sdk";
import { createEndpoint, hostModules } from "./runtime.mjs";
import { projectRouteTransport } from "./route-config.mjs";
export const activate = definePlugin({ async activate(context) {
  const runtime = context.services.require("host.message-endpoints@3");
  await runtime.prepareModules(hostModules);
  const transport = projectRouteTransport(context.config, runtime.module("config").config);
  const host = runtime.forActivation(transport ? { ...context.config, __routeTransport: transport, __routeInheritedFields: [] } : context.config);
  await host.prepareModules(egressModules);
  const egress = createEgress(host);
  ownMessageEndpointEgress(context, { type: "napcat", operations: egress });
  await host.prepareModules(hostModules);
  const endpoint = createEndpoint(host);
  context.services.provide("endpoint.napcat@1", Object.freeze({ type: "napcat" }));
  ownMessageEndpoint(context, endpoint);
} }).activate;
