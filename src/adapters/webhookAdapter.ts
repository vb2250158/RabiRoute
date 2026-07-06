import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessage } from "../forwarding.js";
import { appendAdapterLog, appendVoiceTranscriptEventForAdapter, type VoiceTranscriptEventRecord } from "../history.js";
import type { MessageAdapter, MessageAdapterType } from "./messageAdapter.js";

type WebhookPayload = {
  type?: string;
  source?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceArea?: string;
  deviceId?: string;
  deviceName?: string;
  area?: string;
  sessionId?: string;
  text?: string;
  message?: string;
  content?: string;
  query?: string;
  prompt?: string;
  input?: string;
  question?: string;
  data?: unknown;
  messages?: unknown;
  id?: string;
  messageId?: string;
  time?: number;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  peak?: number;
  speaker_id?: string;
  speakerId?: string;
  speaker_name?: string;
  speakerName?: string;
  speaker_kind?: string;
  speakerKind?: string;
  speaker_confidence?: number;
  speakerConfidence?: number;
  speaker_decision?: string;
  speakerDecision?: string;
};

type GatewayStatus = {
  messageAdapters?: Record<string, {
    type?: MessageAdapterType;
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
  httpCallbacks?: Record<string, {
    label?: string;
    path?: string;
    port?: number;
    url?: string;
    lastEventAt?: string;
    eventCount?: number;
  }>;
};

type HttpWebhookAdapterType = Extract<MessageAdapterType, "webhook" | "fennenote" | "xiaoai" | "rabilink">;

type WebhookAdapterProfile = {
  type: HttpWebhookAdapterType;
  label: string;
  source: string;
  path: string;
  port: number;
  host?: string;
  acceptedTypes: string[];
  missingTextMessage: string;
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

function patchWebhookStatus(profile: WebhookAdapterProfile, patch: NonNullable<GatewayStatus["webhook"]> & { status?: "running" | "error"; message?: string }): void {
  const status = readGatewayStatus();
  const current = status.messageAdapters?.[profile.type] ?? {};
  const shouldKeepGenericWebhook = profile.type === "webhook" || config.messageAdapterTypes.includes("webhook");
  const host = profile.host || "127.0.0.1";
  const nextCallback = {
    ...status.httpCallbacks?.[profile.type],
    label: profile.label,
    path: patch.path ?? status.httpCallbacks?.[profile.type]?.path,
    port: patch.port ?? status.httpCallbacks?.[profile.type]?.port,
    url: patch.path && patch.port ? `http://${host}:${patch.port}${patch.path}` : status.httpCallbacks?.[profile.type]?.url,
    lastEventAt: patch.lastEventAt ?? status.httpCallbacks?.[profile.type]?.lastEventAt,
    eventCount: patch.eventCount ?? status.httpCallbacks?.[profile.type]?.eventCount
  };
  const nextMessageAdapters: NonNullable<GatewayStatus["messageAdapters"]> = {
    ...status.messageAdapters,
    [profile.type]: {
      ...current,
      type: profile.type,
      status: patch.status ?? "running",
      message: patch.message,
      updatedAt: new Date().toISOString(),
      path: patch.path,
      port: patch.port,
      lastEventAt: patch.lastEventAt,
      eventCount: patch.eventCount
    }
  };
  const nextHttpCallbacks: NonNullable<GatewayStatus["httpCallbacks"]> = {
    ...status.httpCallbacks,
    [profile.type]: nextCallback
  };

  if (!shouldKeepGenericWebhook) {
    delete nextMessageAdapters.webhook;
    delete nextHttpCallbacks.webhook;
  }

  const nextStatus: GatewayStatus = {
    ...status,
    messageAdapters: nextMessageAdapters,
    httpCallbacks: nextHttpCallbacks
  };

  if (profile.type === "webhook") {
    nextStatus.webhook = {
      ...status.webhook,
      path: patch.path ?? status.webhook?.path,
      port: patch.port ?? status.webhook?.port,
      lastEventAt: patch.lastEventAt ?? status.webhook?.lastEventAt,
      eventCount: patch.eventCount ?? status.webhook?.eventCount
    };
  } else if (shouldKeepGenericWebhook) {
    nextStatus.webhook = status.webhook;
  } else {
    delete nextStatus.webhook;
  }

  writeGatewayStatus(nextStatus);
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

function stringPayloadField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nestedTextFromData(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }
  const source = data as Record<string, unknown>;
  return stringPayloadField(source.text)
    || stringPayloadField(source.message)
    || stringPayloadField(source.content)
    || stringPayloadField(source.query)
    || stringPayloadField(source.prompt)
    || stringPayloadField(source.input)
    || stringPayloadField(source.question);
}

function textFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (const item of [...messages].reverse()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    const text = stringPayloadField(message.content) || stringPayloadField(message.text);
    if (text) return text;
  }
  return "";
}

function textFromPayload(payload: WebhookPayload): string {
  return stringPayloadField(payload.text)
    || stringPayloadField(payload.message)
    || stringPayloadField(payload.content)
    || stringPayloadField(payload.query)
    || stringPayloadField(payload.prompt)
    || stringPayloadField(payload.input)
    || stringPayloadField(payload.question)
    || nestedTextFromData(payload.data)
    || textFromMessages(payload.messages);
}

function recordFromPayload(payload: WebhookPayload, profile: WebhookAdapterProfile): VoiceTranscriptEventRecord | null {
  const rawMessage = textFromPayload(payload);
  if (!rawMessage) {
    return null;
  }

  return {
    time: payload.time ?? Math.floor(Date.now() / 1000),
    rawMessage,
    messageId: payload.messageId ?? payload.id ?? `${profile.type}-${Date.now()}`,
    senderName: payload.source ?? profile.label,
    adapterType: profile.type,
    source: payload.source ?? profile.source,
    speakerId: payload.speakerId ?? payload.speaker_id,
    speakerName: payload.speakerName ?? payload.speaker_name,
    speakerKind: payload.speakerKind ?? payload.speaker_kind,
    speakerConfidence: payload.speakerConfidence ?? payload.speaker_confidence,
    speakerDecision: payload.speakerDecision ?? payload.speaker_decision,
    sourceDeviceId: payload.sourceDeviceId ?? payload.deviceId,
    sourceDeviceName: payload.sourceDeviceName ?? payload.deviceName,
    sourceArea: payload.sourceArea ?? payload.area,
    sessionId: payload.sessionId,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    durationSeconds: payload.durationSeconds,
    peak: payload.peak
  };
}

function defaultWebhookProfile(): WebhookAdapterProfile {
  return {
    type: "webhook",
    label: "通用 Webhook",
    source: "webhook",
    path: config.webhookPath,
    port: config.webhookPort,
    acceptedTypes: ["voice_transcript", "webhook.text"],
    missingTextMessage: "Webhook payload has no text/message/content"
  };
}

export function createFenneNoteAdapter(): MessageAdapter {
  return createWebhookAdapter({
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    source: "fennenote",
    path: config.fenneNoteWebhookPath,
    port: config.fenneNoteWebhookPort,
    acceptedTypes: ["voice_transcript", "fennenote.voice_transcript", "fennenote.transcript", "webhook.text"],
    missingTextMessage: "FenneNote payload has no text/message/content"
  });
}

export function createXiaoAiAdapter(): MessageAdapter {
  return createWebhookAdapter({
    type: "xiaoai",
    label: "小米音箱 / 小爱",
    source: "xiaoai",
    path: config.xiaoaiWebhookPath,
    port: config.xiaoaiWebhookPort,
    acceptedTypes: ["voice_transcript", "xiaoai.voice_transcript", "xiaoai.transcript", "webhook.text"],
    missingTextMessage: "XiaoAI payload has no text/message/content"
  });
}

export function createRabiLinkAdapter(): MessageAdapter {
  return createWebhookAdapter({
    type: "rabilink",
    label: "RabiLink / Rokid 手机桥",
    source: "rabilink",
    path: config.rabiLinkWebhookPath,
    port: config.rabiLinkWebhookPort,
    host: config.rabiLinkWebhookHost,
    acceptedTypes: ["voice_transcript", "rabilink", "rabilink.text", "rabilink.message", "webhook.text"],
    missingTextMessage: "RabiLink payload has no text/message/content/query/input"
  });
}
export function createWebhookAdapter(profile = defaultWebhookProfile()): MessageAdapter {
  return {
    type: profile.type,
    start() {
      const webhookPath = normalizeWebhookPath(profile.path);
      const server = http.createServer(async (request, response) => {
        const requestPath = request.url?.split("?", 1)[0];
        if (request.method === "GET" && requestPath === webhookPath) {
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({
            ok: true,
            adapterType: profile.type,
            label: profile.label,
            path: webhookPath,
            port: profile.port,
            status: "ready"
          }));
          return;
        }

        if (request.method !== "POST" || requestPath !== webhookPath) {
          appendAdapterLog(profile.type, {
            level: "warning",
            event: "rejected_request",
            message: `Unsupported ${profile.label} request`,
            data: {
              method: request.method,
              url: request.url,
              expectedPath: webhookPath
            }
          });
          response.writeHead(404).end();
          return;
        }

        try {
          const body = await readRequestBody(request);
          const payload = JSON.parse(body || "{}") as WebhookPayload;
          const eventType = payload.type ?? "voice_transcript";
          appendAdapterLog(profile.type, {
            event: "inbound_request",
            message: textFromPayload(payload).slice(0, 500),
            data: {
              adapterType: profile.type,
              label: profile.label,
              path: webhookPath,
              eventType,
              bodyBytes: Buffer.byteLength(body),
              payload
            }
          });
          if (!profile.acceptedTypes.includes(eventType)) {
            appendAdapterLog(profile.type, {
              level: "warning",
              event: "unsupported_type",
              message: `Unsupported ${profile.label} type: ${eventType}`,
              data: { path: webhookPath, eventType }
            });
            response.writeHead(400).end(`Unsupported ${profile.label} type`);
            return;
          }

          const record = recordFromPayload(payload, profile);
          if (!record) {
            appendAdapterLog(profile.type, {
              level: "warning",
              event: "missing_text",
              message: profile.missingTextMessage,
              data: { path: webhookPath, eventType, payload }
            });
            response.writeHead(400).end("Missing text");
            return;
          }

          appendVoiceTranscriptEventForAdapter(profile.type, record);
          const status = readGatewayStatus().messageAdapters?.[profile.type];
          patchWebhookStatus(profile, {
            path: webhookPath,
            port: profile.port,
            lastEventAt: new Date().toISOString(),
            eventCount: (status?.eventCount ?? 0) + 1
          });
          forwardMessage("voice_transcript", record, {
            webhookPath,
            inputAdapter: profile.type,
            voiceSource: record.source
          });
          appendAdapterLog(profile.type, {
            event: "accepted",
            message: record.rawMessage.slice(0, 500),
            data: {
              adapterType: profile.type,
              label: profile.label,
              path: webhookPath,
              messageId: record.messageId,
              source: record.source,
              sessionId: record.sessionId
            }
          });
          if (profile.type === "rabilink") {
            const replyText = "已转交 Codex 处理。";
            response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({
              ok: true,
              status: "accepted",
              messageId: record.messageId,
              text: replyText,
              answer: replyText,
              reply: replyText,
              content: replyText
            }));
          } else {
            response.writeHead(204).end();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          patchWebhookStatus(profile, {
            status: "error",
            message,
            path: webhookPath,
            port: profile.port
          });
          appendAdapterLog(profile.type, {
            level: "error",
            event: "error",
            message,
            data: {
              path: webhookPath,
              port: profile.port
            }
          });
          response.writeHead(500).end(message);
        }
      });

      const host = profile.host || "127.0.0.1";
      server.listen(profile.port, host, () => {
        patchWebhookStatus(profile, {
          status: "running",
          message: `${profile.label} 消息端已启动。`,
          path: webhookPath,
          port: profile.port
        });
        const url = `http://${host}:${profile.port}${webhookPath}`;
        appendAdapterLog(profile.type, {
          event: "listening",
          message: `${profile.label} listening on ${url}`,
          data: {
            path: webhookPath,
            port: profile.port,
            host,
            url
          }
        });
        console.log(`RabiRoute ${profile.label} adapter listening on ${url}`);
      });
    }
  };
}
