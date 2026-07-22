import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessage, recordMessageContextOnly } from "../forwarding.js";
import { appendAdapterLog, appendVoiceTranscriptEventForAdapter, type VoiceTranscriptEventRecord } from "../history.js";
import { isRabiLinkRecordFirstSource, recordRabiLinkVoiceObservation } from "../rabilinkObservationRecorder.js";
import type { ForwardRouteKind } from "../routing/types.js";
import type { MessageAdapter, MessageAdapterType } from "./messageAdapter.js";

export type WebhookPayload = {
  type?: string;
  source?: string;
  sender?: string;
  context?: string;
  sourceDeviceId?: string;
  sourceDeviceName?: string;
  sourceDeviceKind?: string;
  transport?: string;
  sourceArea?: string;
  deviceId?: string;
  deviceName?: string;
  area?: string;
  sessionId?: string;
  routeProfileId?: string;
  configurationRequested?: boolean;
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
    relayUrl?: string;
    relayDeviceId?: string;
    relayWorker?: "running" | "disabled" | "error";
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

export type WebhookAdapterProfile = {
  type: MessageAdapterType;
  label: string;
  source: string;
  path: string;
  port: number;
  host?: string;
  acceptedTypes: string[];
  routeKind: ForwardRouteKind;
  missingTextMessage: string;
};

type AcceptedWebhookResponse = {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
};

type WebhookAdapterRequestContext = {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  requestUrl: URL;
  requestPath: string;
  webhookPath: string;
  profile: WebhookAdapterProfile;
};

type WebhookAdapterListeningContext = {
  webhookPath: string;
  profile: WebhookAdapterProfile;
};

type WebhookAdapterOptions = {
  handleRequest?(context: WebhookAdapterRequestContext): boolean | Promise<boolean>;
  acceptedResponse?(record: VoiceTranscriptEventRecord, payload: WebhookPayload): AcceptedWebhookResponse;
  onListening?(context: WebhookAdapterListeningContext): void;
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
      relayUrl: current.relayUrl,
      relayDeviceId: current.relayDeviceId,
      relayWorker: current.relayWorker,
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

export function patchRelayStatus(profile: WebhookAdapterProfile, patch: {
  status?: "running" | "error";
  message?: string;
  relayWorker?: "running" | "disabled" | "error";
  relayUrl?: string;
  relayDeviceId?: string;
}): void {
  const status = readGatewayStatus();
  const current = status.messageAdapters?.[profile.type] ?? {};
  writeGatewayStatus({
    ...status,
    messageAdapters: {
      ...status.messageAdapters,
      [profile.type]: {
        ...current,
        type: profile.type,
        status: patch.status ?? current.status ?? "running",
        message: patch.message ?? current.message,
        updatedAt: new Date().toISOString(),
        path: current.path,
        port: current.port,
        lastEventAt: current.lastEventAt,
        eventCount: current.eventCount,
        relayUrl: patch.relayUrl ?? current.relayUrl,
        relayDeviceId: patch.relayDeviceId ?? current.relayDeviceId,
        relayWorker: patch.relayWorker ?? current.relayWorker
      }
    }
  });
}

export function normalizeWebhookPath(rawPath: string): string {
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

export function stringPayloadField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function nestedTextFromData(data: unknown): string {
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
    messageId: payload.messageId ?? payload.id,
    senderName: payload.sender ?? payload.source ?? profile.label,
    adapterType: profile.type,
    source: payload.source ?? payload.sender ?? profile.source,
    speakerId: payload.speakerId ?? payload.speaker_id,
    speakerName: payload.speakerName ?? payload.speaker_name,
    speakerKind: payload.speakerKind ?? payload.speaker_kind,
    speakerConfidence: payload.speakerConfidence ?? payload.speaker_confidence,
    speakerDecision: payload.speakerDecision ?? payload.speaker_decision,
    sourceDeviceId: payload.sourceDeviceId ?? payload.deviceId,
    sourceDeviceName: payload.sourceDeviceName ?? payload.deviceName,
    sourceDeviceKind: payload.sourceDeviceKind,
    transport: payload.transport,
    sourceArea: payload.sourceArea ?? payload.area,
    sessionId: payload.sessionId ?? payload.context,
    routeProfileId: payload.routeProfileId,
    configurationRequested: payload.configurationRequested === true,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    durationSeconds: payload.durationSeconds,
    peak: payload.peak
  };
}

export function acceptWebhookPayload(
  profile: WebhookAdapterProfile,
  webhookPath: string,
  payload: WebhookPayload,
  bodyBytes: number,
  options: { forward?: boolean; recordFirst?: boolean } = {}
): VoiceTranscriptEventRecord {
  const eventType = payload.type ?? "voice_transcript";
  appendAdapterLog(profile.type, {
    event: "inbound_request",
    message: textFromPayload(payload).slice(0, 500),
    data: {
      adapterType: profile.type,
      label: profile.label,
      path: webhookPath,
      eventType,
      bodyBytes,
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
    throw new Error(`Unsupported ${profile.label} type`);
  }

  const record = recordFromPayload(payload, profile);
  if (!record) {
    appendAdapterLog(profile.type, {
      level: "warning",
      event: "missing_text",
      message: profile.missingTextMessage,
      data: { path: webhookPath, eventType, payload }
    });
    throw new Error("Missing text");
  }

  const recordFirst = options.recordFirst ?? isRabiLinkRecordFirstSource(profile.type, record.source);
  if (recordFirst) {
    recordRabiLinkVoiceObservation(record);
  }

  appendVoiceTranscriptEventForAdapter(profile.type, record);
  const status = readGatewayStatus().messageAdapters?.[profile.type];
  patchWebhookStatus(profile, {
    path: webhookPath,
    port: profile.port,
    lastEventAt: new Date().toISOString(),
    eventCount: (status?.eventCount ?? 0) + 1
  });
  if (options.forward !== false && !recordFirst) {
    forwardMessage(profile.routeKind, record, {
      webhookPath,
      inputAdapter: profile.type,
      voiceSource: record.source,
      configurationRequested: record.configurationRequested ? "true" : undefined
    });
  } else {
    recordMessageContextOnly(profile.routeKind, record);
  }
  appendAdapterLog(profile.type, {
    event: "accepted",
    message: record.rawMessage.slice(0, 500),
    data: {
      adapterType: profile.type,
      label: profile.label,
      path: webhookPath,
      messageId: record.messageId,
      source: record.source,
      sessionId: record.sessionId,
      forwarding: recordFirst || options.forward === false ? "record_only" : "direct"
    }
  });
  return record;
}

function defaultWebhookProfile(): WebhookAdapterProfile {
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

export function createFenneNoteAdapter(): MessageAdapter {
  return createWebhookAdapter({
    type: "fennenote",
    label: "FenneNote / 芬妮笔记",
    source: "fennenote",
    path: config.fenneNoteWebhookPath,
    port: config.fenneNoteWebhookPort,
    acceptedTypes: ["voice_transcript", "fennenote.voice_transcript", "fennenote.transcript", "webhook.text"],
    routeKind: "voice_transcript",
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
    routeKind: "voice_transcript",
    missingTextMessage: "XiaoAI payload has no text/message/content"
  });
}

export function createWebhookAdapter(profile = defaultWebhookProfile(), options: WebhookAdapterOptions = {}): MessageAdapter {
  return {
    type: profile.type,
    start() {
      const webhookPath = normalizeWebhookPath(profile.path);
      const server = http.createServer(async (request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const requestPath = requestUrl.pathname;
        const handled = await options.handleRequest?.({ request, response, requestUrl, requestPath, webhookPath, profile });
        if (handled) {
          return;
        }

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
          const record = acceptWebhookPayload(profile, webhookPath, payload, Buffer.byteLength(body));
          const acceptedResponse = options.acceptedResponse?.(record, payload) ?? { statusCode: 204 };
          response.writeHead(acceptedResponse.statusCode, acceptedResponse.headers).end(acceptedResponse.body);
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
        options.onListening?.({ webhookPath, profile });
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
