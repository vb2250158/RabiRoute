import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessage } from "../forwarding.js";
import { appendVoiceTranscriptEvent, type VoiceTranscriptEventRecord } from "../history.js";
import type { MessageAdapter } from "./messageAdapter.js";

type WebhookPayload = {
  type?: string;
  source?: string;
  text?: string;
  message?: string;
  content?: string;
  id?: string;
  messageId?: string;
  time?: number;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  peak?: number;
};

type GatewayStatus = {
  messageAdapters?: Record<string, {
    status?: "running" | "error";
    message?: string;
    updatedAt?: string;
    path?: string;
    port?: number;
    lastEventAt?: string;
    eventCount?: number;
  }>;
  webhook?: {
    path?: string;
    port?: number;
    lastEventAt?: string;
    eventCount?: number;
  };
};

const statusPath = path.join(config.dataDir, "gateway-status.json");

function readGatewayStatus(): GatewayStatus {
  if (!fs.existsSync(statusPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus;
  } catch {
    return {};
  }
}

function writeGatewayStatus(nextStatus: GatewayStatus): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(nextStatus, null, 2), "utf8");
}

function patchWebhookStatus(patch: NonNullable<GatewayStatus["webhook"]> & { status?: "running" | "error"; message?: string }): void {
  const status = readGatewayStatus();
  const current = status.messageAdapters?.webhook ?? {};
  writeGatewayStatus({
    ...status,
    messageAdapters: {
      ...status.messageAdapters,
      webhook: {
        ...current,
        status: patch.status ?? "running",
        message: patch.message,
        updatedAt: new Date().toISOString(),
        path: patch.path,
        port: patch.port,
        lastEventAt: patch.lastEventAt,
        eventCount: patch.eventCount
      }
    },
    webhook: {
      ...status.webhook,
      path: patch.path ?? status.webhook?.path,
      port: patch.port ?? status.webhook?.port,
      lastEventAt: patch.lastEventAt ?? status.webhook?.lastEventAt,
      eventCount: patch.eventCount ?? status.webhook?.eventCount
    }
  });
}

function normalizeWebhookPath(rawPath: string): string {
  const trimmed = rawPath.trim() || "/webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).byteLength > 1024 * 1024) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function recordFromPayload(payload: WebhookPayload): VoiceTranscriptEventRecord | null {
  const rawMessage = String(payload.text ?? payload.message ?? payload.content ?? "").trim();
  if (!rawMessage) {
    return null;
  }

  return {
    time: payload.time ?? Math.floor(Date.now() / 1000),
    rawMessage,
    messageId: payload.messageId ?? payload.id ?? `fennenote-${Date.now()}`,
    senderName: payload.source ?? "FenneNote",
    source: payload.source ?? "fennenote",
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    durationSeconds: payload.durationSeconds,
    peak: payload.peak
  };
}

export function createWebhookAdapter(): MessageAdapter {
  return {
    type: "webhook",
    start() {
      const webhookPath = normalizeWebhookPath(config.webhookPath);
      const server = http.createServer(async (request, response) => {
        if (request.method !== "POST" || request.url?.split("?", 1)[0] !== webhookPath) {
          response.writeHead(404).end();
          return;
        }

        try {
          const body = await readRequestBody(request);
          const payload = JSON.parse(body || "{}") as WebhookPayload;
          const eventType = payload.type ?? "voice_transcript";
          if (eventType !== "voice_transcript" && eventType !== "fennenote.transcript") {
            response.writeHead(400).end("Unsupported webhook type");
            return;
          }

          const record = recordFromPayload(payload);
          if (!record) {
            response.writeHead(400).end("Missing text");
            return;
          }

          appendVoiceTranscriptEvent(record);
          const status = readGatewayStatus().webhook;
          patchWebhookStatus({
            path: webhookPath,
            port: config.gatewayPort,
            lastEventAt: new Date().toISOString(),
            eventCount: (status?.eventCount ?? 0) + 1
          });
          forwardMessage("voice_transcript", record, {
            webhookPath
          });
          response.writeHead(204).end();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          patchWebhookStatus({
            status: "error",
            message,
            path: webhookPath,
            port: config.gatewayPort
          });
          response.writeHead(500).end(message);
        }
      });

      server.listen(config.gatewayPort, "127.0.0.1", () => {
        patchWebhookStatus({
          status: "running",
          message: "Webhook 消息适配端已启动。",
          path: webhookPath,
          port: config.gatewayPort
        });
        console.log(`RabiRoute webhook adapter listening on http://127.0.0.1:${config.gatewayPort}${webhookPath}`);
      });
    }
  };
}
