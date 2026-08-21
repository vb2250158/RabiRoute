import { config } from "../config.js";
import type { MessageAdapter } from "./messageAdapter.js";
import { localRabiLinkReplies } from "./rabilinkReplies.js";
import { acquireRabiLinkRelayWorker } from "./rabilinkRelayWorker.js";
import { createWebhookAdapter, type WebhookAdapterProfile } from "./webhookAdapter.js";

export function rabiLinkAdapterProfile(): WebhookAdapterProfile {
  return {
    type: "rabilink",
    label: "RabiLink / Relay 直连",
    source: "rabilink",
    path: config.rabiLinkWebhookPath,
    port: config.rabiLinkWebhookPort,
    host: config.rabiLinkWebhookHost,
    acceptedTypes: ["voice_transcript", "rabilink", "rabilink.text", "rabilink.message", "webhook.text"],
    routeKind: "rabilink",
    missingTextMessage: "RabiLink payload has no text/message/content/query/input"
  };
}

export function createRabiLinkAdapter(): MessageAdapter {
  return createWebhookAdapter(rabiLinkAdapterProfile(), {
    handleRequest({ request, response, requestUrl, requestPath, webhookPath }) {
      if (request.method !== "GET" || requestPath !== `${webhookPath}/replies`) {
        return false;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(localRabiLinkReplies(requestUrl)));
      return true;
    },
    acceptedResponse(record) {
      const replyText = "已转交 Codex 处理。";
      return {
        statusCode: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ok: true,
          status: "accepted",
          messageId: record.messageId,
          text: replyText,
          answer: replyText,
          reply: replyText,
          content: replyText
        })
      };
    },
    async onListening({ profile, webhookPath }) {
      const lease = await acquireRabiLinkRelayWorker(profile, webhookPath);
      return () => lease.release();
    }
  });
}
