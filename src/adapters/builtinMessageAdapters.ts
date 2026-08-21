import { createHeartbeatAdapter } from "./heartbeatAdapter.js";
import { createNapCatAdapter } from "./napcatAdapter.js";
import { createWebhookAdapter } from "./webhookAdapter.js";
import { createWeComAdapter } from "./wecomAdapter.js";
import { createWeixinAdapter } from "./weixinAdapter.js";
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

export const napcatMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "napcat",
    label: "NapCat / OneBot",
    host: "gateway",
    transport: "websocket",
    lifecycle: "fiber"
  },
  create: () => createNapCatAdapter()
};

export const wecomMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "wecom",
    label: "企业微信",
    host: "gateway",
    transport: "websocket",
    lifecycle: "fiber"
  },
  create: () => createWeComAdapter()
};

export const weixinMessageAdapterDefinition: MessageAdapterDefinition = {
  manifest: {
    type: "weixin",
    label: "个人微信",
    host: "gateway",
    transport: "http",
    lifecycle: "fiber"
  },
  create: () => createWeixinAdapter()
};

export function builtinMessageAdapterDefinitions(): MessageAdapterDefinition[] {
  return [
    webhookMessageAdapterDefinition,
    heartbeatMessageAdapterDefinition,
    napcatMessageAdapterDefinition,
    wecomMessageAdapterDefinition,
    weixinMessageAdapterDefinition
  ];
}
