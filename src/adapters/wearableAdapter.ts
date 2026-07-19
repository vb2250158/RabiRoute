import { config } from "../config.js";
import type { MessageAdapter } from "./messageAdapter.js";
import { startRabiLinkRelayWorker } from "./rabilinkRelayWorker.js";
import type { WebhookAdapterProfile } from "./webhookAdapter.js";

export function wearableAdapterProfile(): WebhookAdapterProfile {
  return {
    type: "wearable",
    label: "智能手表/手环消息端",
    source: "wearable-health",
    path: "/wearable-health",
    port: config.rabiLinkWebhookPort,
    host: config.rabiLinkWebhookHost,
    acceptedTypes: ["wearable.health"],
    routeKind: "wearable_health_alert",
    missingTextMessage: "Wearable health alert has no text"
  };
}

/**
 * Wearables reuse the Manager-owned RabiLink transport instead of opening a
 * second callback server. Structured samples are persisted by the common
 * Relay worker; only policy alerts enter Agent routing.
 */
export function createWearableAdapter(): MessageAdapter {
  return {
    type: "wearable",
    start() {
      startRabiLinkRelayWorker(wearableAdapterProfile(), config.rabiLinkWebhookPath);
    }
  };
}
