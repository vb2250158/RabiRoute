import { config } from "@rabiroute/host-api/config";
import { createWebhookAdapter, type WebhookAdapterProfile } from "@rabiroute/host-api/adapters/webhookAdapter";

/** This endpoint owns its default ingress contract; the shared listener driver also serves RabiLink and FenneNote. */
export function webhookEndpointProfile(): WebhookAdapterProfile {
  return {
    type: "webhook",
    label: "通用 Webhook",
    source: "webhook",
    path: config.webhookPath,
    port: config.webhookPort,
    acceptedTypes: ["voice_transcript", "webhook.text"],
    routeKind: "voice_transcript",
    missingTextMessage: "Webhook payload has no text/message/content"
  };
}

export function createWebhookEndpoint() {
  return createWebhookAdapter(webhookEndpointProfile());
}
