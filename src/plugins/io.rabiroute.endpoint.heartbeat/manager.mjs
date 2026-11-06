import { definePlugin } from "@rabiroute/plugin-sdk";

// Automation owns schedule configuration. This package supplies its single timer worker.
export const activate = definePlugin({ activate(context) {
  context.services.provide("endpoint.heartbeat@1", Object.freeze({
    type: "heartbeat", instanceId: context.identity.instanceId, internal: true
  }));
} }).activate;
