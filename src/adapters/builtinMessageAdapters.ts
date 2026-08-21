import { createHeartbeatAdapter } from "./heartbeatAdapter.js";
import { createWebhookAdapter } from "./webhookAdapter.js";
import type { MessageAdapterDefinition } from "./messageAdapter.js";

export const webhookMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "webhook",
    label: "通用 Webhook",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  },
  create: () => createWebhookAdapter()
};

export const heartbeatMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "heartbeat",
    label: "定时触发",
    host: "gateway",
    transport: "timer",
    lifecycle: "fiber"
  },
  create: () => createHeartbeatAdapter()
};

export function builtinMessageAdapterDefinitions(): MessageAdapterDefinition[] {
  return [webhookMessageAdapterDefinition, heartbeatMessageAdapterDefinition];
}
