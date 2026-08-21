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

export function builtinMessageAdapterDefinitions(): MessageAdapterDefinition[] {
  return [webhookMessageAdapterDefinition];
}
