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
  sender?: string;
  context?: string;
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

type HttpWebhookAdapterType = Extract<MessageAdapterType, "webhook" | "fennenote" | "xiaoai" | "rabilink">;

type WebhookAdapterProfile = {
  type: HttpWebhookAdapterType;
  label: string;
  source: string;
  path: string;
  port: number;
  host?: string;
  acceptedTypes: string[];
  routeKind: "voice_transcript" | "rabilink";
  missingTextMessage: string;
};

const statusPath = path.join(config.dataDir, "gateway-status.json");

function readJsonlTail(filePath: string, limit: number, afterId: string): Record<string, unknown>[] {
  if (!fs.existsSync(filePath)) return [];
  const rows = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const afterIndex = afterId ? rows.findIndex((item) => String(item.id ?? "") === afterId) : -1;
  const selected = afterIndex >= 0 ? rows.slice(afterIndex + 1) : rows.slice(-limit);
  return selected.slice(-limit);
}

function localRabiLinkReplies(requestUrl: URL): Record<string, unknown> {
  const limit = Math.max(1, Math.min(100, Number(requestUrl.searchParams.get("limit") || 20) || 20));
  const afterId = String(requestUrl.searchParams.get("afterId") || requestUrl.searchParams.get("after") || "");
  const filePath = replyLogFilePath();
  const replies = readJsonlTail(filePath, limit, afterId);
  const cursor = String(replies.at(-1)?.id ?? "");
  return {
    ok: true,
    code: 0,
    data: {
      file: path.relative(process.cwd(), filePath).replace(/\\/g, "/"),
      replies,
      cursor,
      nextCursor: cursor
    },
    replies,
    cursor,
    nextCursor: cursor
  };
}

function replyLogFilePath(): string {
  return path.join(config.dataDir, "rabilink-replies.jsonl");
}

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

function patchRelayStatus(profile: WebhookAdapterProfile, patch: {
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
    sourceArea: payload.sourceArea ?? payload.area,
    sessionId: payload.sessionId ?? payload.context,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    durationSeconds: payload.durationSeconds,
    peak: payload.peak
  };
}

function acceptWebhookPayload(profile: WebhookAdapterProfile, webhookPath: string, payload: WebhookPayload, bodyBytes: number): VoiceTranscriptEventRecord {
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

  appendVoiceTranscriptEventForAdapter(profile.type, record);
  const status = readGatewayStatus().messageAdapters?.[profile.type];
  patchWebhookStatus(profile, {
    path: webhookPath,
    port: profile.port,
    lastEventAt: new Date().toISOString(),
    eventCount: (status?.eventCount ?? 0) + 1
  });
  forwardMessage(profile.routeKind, record, {
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
  return record;
}

type RelayTask = Record<string, unknown>;

const runningRelayWorkers = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedRelayBaseUrl(): string {
  return config.rabiLinkRelayUrl.trim().replace(/\/+$/, "");
}

function relayHeaders(hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RabiLink-Token": config.rabiLinkRelayToken,
    "User-Agent": "RabiRoute/1.0"
  };
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function fetchRelayJson(pathname: string, init: RequestInit = {}, fallbackPathname?: string): Promise<Record<string, unknown>> {
  const baseUrl = normalizedRelayBaseUrl();
  const response = await fetch(`${baseUrl}${pathname}`, init);
  if (response.status === 404 && fallbackPathname) {
    return fetchRelayJson(fallbackPathname, init);
  }
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    throw new Error(String(body.message || body.error || `${response.status} ${response.statusText}`));
  }
  return body;
}

function taskFromClaimResponse(body: Record<string, unknown>): RelayTask | null {
  if (body.task && typeof body.task === "object" && !Array.isArray(body.task)) {
    return body.task as RelayTask;
  }
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) {
    const data = body.data as Record<string, unknown>;
    if (data.task && typeof data.task === "object" && !Array.isArray(data.task)) {
      return data.task as RelayTask;
    }
    if (Array.isArray(data.tasks) && data.tasks[0] && typeof data.tasks[0] === "object") {
      return data.tasks[0] as RelayTask;
    }
  }
  if (Array.isArray(body.tasks) && body.tasks[0] && typeof body.tasks[0] === "object") {
    return body.tasks[0] as RelayTask;
  }
  return null;
}

function relayTaskId(task: RelayTask): string {
  return stringPayloadField(task.id) || stringPayloadField(task.taskId);
}

function relayTaskText(task: RelayTask): string {
  return stringPayloadField(task.text)
    || stringPayloadField(task.normalizedText)
    || stringPayloadField(task.message)
    || stringPayloadField(task.content)
    || stringPayloadField(task.query)
    || stringPayloadField(task.prompt)
    || nestedTextFromData(task.data);
}

function payloadFromRelayTask(task: RelayTask, taskId: string): WebhookPayload {
  const sender = stringPayloadField(task.sender) || stringPayloadField(task.source) || "Rokid Glass";
  return {
    type: "rabilink",
    id: taskId,
    messageId: taskId,
    sender,
    source: sender,
    context: stringPayloadField(task.context),
    sessionId: stringPayloadField(task.conversationId) || stringPayloadField(task.sessionId),
    text: relayTaskText(task),
    data: task,
    sourceDeviceId: stringPayloadField(task.deviceId),
    sourceDeviceName: stringPayloadField(task.deviceName) || "Rokid Relay"
  };
}

function replyContextOf(row: Record<string, unknown>): Record<string, unknown> {
  const context = row.replyContext;
  return context && typeof context === "object" && !Array.isArray(context) ? context as Record<string, unknown> : {};
}

function replyMatchesTask(row: Record<string, unknown>, taskId: string): boolean {
  const context = replyContextOf(row);
  const messageId = stringPayloadField(row.messageId) || stringPayloadField(context.messageId);
  return messageId === taskId;
}

function replyText(row: Record<string, unknown>): string {
  return stringPayloadField(row.text)
    || stringPayloadField(row.reply)
    || stringPayloadField(row.answer)
    || stringPayloadField(row.content)
    || nestedTextFromData(row.payload);
}

function replyIsFinal(row: Record<string, unknown>): boolean {
  const status = stringPayloadField(row.status).toLowerCase();
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  return row.done === true
    || row.final === true
    || payload.done === true
    || payload.final === true
    || status === "done"
    || status === "failed";
}

function replyKey(row: Record<string, unknown>, index: number): string {
  return stringPayloadField(row.id)
    || stringPayloadField(row.sentMessageId)
    || `${stringPayloadField(row.messageId)}:${row.time ?? ""}:${replyText(row).slice(0, 80)}:${index}`;
}

async function appendRelayMessage(taskId: string, text: string, raw: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ text, raw });
  await fetchRelayJson(`/worker/tasks/${encodeURIComponent(taskId)}/messages`, {
    method: "POST",
    headers: relayHeaders(true),
    body
  });
}

async function finishRelayTask(taskId: string, body: Record<string, unknown>): Promise<void> {
  await fetchRelayJson(`/worker/tasks/${encodeURIComponent(taskId)}/finish`, {
    method: "POST",
    headers: relayHeaders(true),
    body: JSON.stringify(body)
  });
}

async function streamRepliesToRelay(taskId: string): Promise<{ deliveredCount: number; sawFinal: boolean }> {
  const delivered = new Set<string>();
  let lastActivityAt = Date.now();
  let sawFinal = false;
  let deliveredCount = 0;
  const idleTimeoutMs = config.rabiLinkRelayReplyIdleTimeoutMs;
  while (Date.now() - lastActivityAt <= idleTimeoutMs) {
    const rows = readJsonlTail(replyLogFilePath(), 500, "").filter((row) => replyMatchesTask(row, taskId));
    for (const [index, row] of rows.entries()) {
      const key = replyKey(row, index);
      const text = replyText(row);
      if (text && !delivered.has(key)) {
        await appendRelayMessage(taskId, text, row);
        delivered.add(key);
        deliveredCount += 1;
        lastActivityAt = Date.now();
      }
      if (replyIsFinal(row)) {
        sawFinal = true;
      }
    }
    if (sawFinal) {
      return { deliveredCount, sawFinal: true };
    }
    await sleep(config.rabiLinkRelayReplyPollMs);
  }
  return { deliveredCount, sawFinal: false };
}

async function handleRelayTask(profile: WebhookAdapterProfile, webhookPath: string, task: RelayTask): Promise<void> {
  const taskId = relayTaskId(task);
  if (!taskId) {
    throw new Error("Relay task has no id.");
  }
  const payload = payloadFromRelayTask(task, taskId);
  const record = acceptWebhookPayload(profile, webhookPath, payload, Buffer.byteLength(JSON.stringify(payload)));
  appendAdapterLog(profile.type, {
    event: "relay_task_claimed",
    message: record.rawMessage.slice(0, 500),
    data: { taskId, relayUrl: normalizedRelayBaseUrl() }
  });
  const result = await streamRepliesToRelay(taskId);
  await finishRelayTask(taskId, result.deliveredCount > 0
    ? { ok: true, status: "done", idleTimeout: !result.sawFinal }
    : { ok: false, status: "failed", error: "RabiLink PC worker timed out waiting for a final reply." });
}

async function claimRelayTask(): Promise<RelayTask | null> {
  const waitMs = config.rabiLinkRelayClaimWaitMs;
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.rabiLinkRelayDeviceId,
    waitMs: String(waitMs)
  });
  const body = await fetchRelayJson(`/worker/tasks?${params}`, {
    method: "GET",
    headers: relayHeaders()
  });
  return taskFromClaimResponse(body);
}

function startRabiLinkRelayWorker(profile: WebhookAdapterProfile, webhookPath: string): void {
  if (profile.type !== "rabilink") return;
  if (!config.rabiLinkRelayEnabled || !normalizedRelayBaseUrl()) {
    patchRelayStatus(profile, { relayWorker: "disabled", message: "RabiLink Relay worker is disabled." });
    return;
  }
  const workerKey = `${profile.type}:${normalizedRelayBaseUrl()}:${config.rabiLinkRelayDeviceId}`;
  if (runningRelayWorkers.has(workerKey)) return;
  runningRelayWorkers.add(workerKey);
  void (async () => {
    patchRelayStatus(profile, {
      relayWorker: "running",
      relayUrl: normalizedRelayBaseUrl(),
      relayDeviceId: config.rabiLinkRelayDeviceId,
      message: "RabiLink Relay worker 已启动。"
    });
    while (true) {
      try {
        const task = await claimRelayTask();
        if (!task) continue;
        await handleRelayTask(profile, webhookPath, task);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        patchRelayStatus(profile, { status: "error", relayWorker: "error", message });
        appendAdapterLog(profile.type, {
          level: "error",
          event: "relay_worker_error",
          message,
          data: {
            relayUrl: normalizedRelayBaseUrl(),
            relayDeviceId: config.rabiLinkRelayDeviceId
          }
        });
        await sleep(3000);
        patchRelayStatus(profile, { status: "running", relayWorker: "running", message: "RabiLink Relay worker 已恢复轮询。" });
      }
    }
  })();
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

export function createRabiLinkAdapter(): MessageAdapter {
  return createWebhookAdapter({
    type: "rabilink",
    label: "RabiLink / Relay 直连",
    source: "rabilink",
    path: config.rabiLinkWebhookPath,
    port: config.rabiLinkWebhookPort,
    host: config.rabiLinkWebhookHost,
    acceptedTypes: ["voice_transcript", "rabilink", "rabilink.text", "rabilink.message", "webhook.text"],
    routeKind: "rabilink",
    missingTextMessage: "RabiLink payload has no text/message/content/query/input"
  });
}
export function createWebhookAdapter(profile = defaultWebhookProfile()): MessageAdapter {
  return {
    type: profile.type,
    start() {
      const webhookPath = normalizeWebhookPath(profile.path);
      const server = http.createServer(async (request, response) => {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const requestPath = requestUrl.pathname;
        if (profile.type === "rabilink" && request.method === "GET" && requestPath === `${webhookPath}/replies`) {
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(localRabiLinkReplies(requestUrl)));
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
        startRabiLinkRelayWorker(profile, webhookPath);
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
