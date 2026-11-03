import { definePlugin, ownMessageEndpoint } from "@rabiroute/plugin-sdk";
import { createEndpoint, hostModules } from "./runtime.mjs";
export const activate = definePlugin({ async activate(context) {
  const runtime = context.services.require("host.message-endpoints@1");
  const host = runtime.forActivation(context.config);
  await host.prepareModules(hostModules);
  const endpoint = createEndpoint(host);
  context.services.provide("endpoint.heartbeat@1", Object.freeze({ type: "heartbeat" }));
  ownMessageEndpoint(context, endpoint);
} }).activate;
