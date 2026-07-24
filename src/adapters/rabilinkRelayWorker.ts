import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessage } from "../forwarding.js";
import { appendAdapterLog } from "../history.js";
import {
  appendRabiLinkConversationEntry,
  DEFAULT_RABILINK_CONVERSATION_SPLIT_AFTER_MS
} from "../rabilinkConversationLedger.js";
import { startDefaultRabiLinkConversationReviewer } from "../rabilinkConversationReviewer.js";
import {
  ingestWearableHealthObservation,
  type WearableHealthObservationInput
} from "../wearableHealth.js";
import {
  buildWearableHealthAlertRecord,
  wearableHealthAlertTemplateValues
} from "../wearableHealthAlertDelivery.js";
import {
  acceptWebhookPayload,
  nestedTextFromData,
  patchRelayStatus,
  stringPayloadField,
  type WebhookAdapterProfile,
  type WebhookPayload
} from "./webhookAdapter.js";

type RelayTask = Record<string, unknown>;
export type RabiLinkRelayTaskDisposition = "review_request" | "record_only" | "direct";

export function rabiLinkRelayTaskNeedsReviewWake(disposition: RabiLinkRelayTaskDisposition): boolean {
  return disposition !== "direct";
}

const runningRelayWorkers = new Set<string>();
const acceptedRelayTasks = new Map<string, number>();
const MAX_ACCEPTED_RELAY_TASKS = 2048;
const RELAY_WRITE_ATTEMPTS = 4;
const RELAY_WRITE_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedRelayBaseUrl(): string {
  return config.rabiLinkRelayUrl.trim().replace(/\/+$/, "");
}

function relayHeaders(hasBody = false): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RabiLink-Token": config.rabiLinkRelayAppToken,
    "User-Agent": "RabiRoute/1.0"
  };
  if (hasBody) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function relayWorkerIdentityPayload(): Record<string, string> {
  return {
    deviceId: config.rabiLinkRelayDeviceId,
    deviceGuid: config.rabiLinkRelayDeviceGuid
  };
}

async function fetchRelayJson(
  pathname: string,
  init: RequestInit = {},
  fallbackPathname?: string,
  relayBaseUrl = "",
  timeoutMs = 0
): Promise<Record<string, unknown>> {
  const baseUrl = relayBaseUrl.trim().replace(/\/+$/, "") || normalizedRelayBaseUrl();
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller?.abort(upstreamSignal?.reason);
  if (controller && upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }
  const timer = controller
    ? setTimeout(() => controller.abort(new Error(`RabiLink Relay request timed out after ${timeoutMs} ms.`)), timeoutMs)
    : null;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      signal: controller?.signal || upstreamSignal
    });
  } finally {
    if (timer) clearTimeout(timer);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
  if (response.status === 404 && fallbackPathname) {
    return fetchRelayJson(fallbackPathname, init, undefined, baseUrl, timeoutMs);
  }
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    throw new Error(String(body.message || body.error || `${response.status} ${response.statusText}`));
  }
  return body;
}

async function consumeRelayEvents(onEvent: (eventType: string) => void): Promise<void> {
  const params = new URLSearchParams({
    deviceId: config.rabiLinkRelayDeviceId,
    deviceGuid: config.rabiLinkRelayDeviceGuid,
    deviceName: hostname(),
    capabilities: "tasks"
  });
  const response = await fetch(`${normalizedRelayBaseUrl()}/api/rabilink/events?${params}`, {
    method: "GET",
    headers: { ...relayHeaders(), accept: "text/event-stream" }
  });
  if (!response.ok || !response.body) {
    throw new Error(`RabiLink Relay event stream failed: ${response.status} ${response.statusText}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) {
        onEvent(eventType);
        eventType = "message";
      } else if (line.startsWith("event:")) {
        eventType = line.slice(6).trim() || "message";
      }
    }
  }
}

async function fetchRelayJsonReliably(
  pathname: string,
  init: RequestInit,
  relayBaseUrl = ""
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RELAY_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await fetchRelayJson(pathname, init, undefined, relayBaseUrl, RELAY_WRITE_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (attempt < RELAY_WRITE_ATTEMPTS) await sleep(150 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "RabiLink Relay request failed."));
}

function rememberAcceptedRelayTask(taskId: string): void {
  acceptedRelayTasks.delete(taskId);
  acceptedRelayTasks.set(taskId, Date.now());
  while (acceptedRelayTasks.size > MAX_ACCEPTED_RELAY_TASKS) {
    const oldest = acceptedRelayTasks.keys().next().value;
    if (typeof oldest !== "string") break;
    acceptedRelayTasks.delete(oldest);
  }
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
  const sender = stringPayloadField(task.sender) || relayTaskSender(task) || "RabiLink device";
  return {
    type: "rabilink",
    id: taskId,
    messageId: taskId,
    sender,
    source: sender,
    context: stringPayloadField(task.context),
    sessionId: stringPayloadField(task.conversationId) || stringPayloadField(task.sessionId),
    routeProfileId: stringPayloadField(task.routeProfileId),
    configurationRequested: task.configurationRequested === true,
    text: relayTaskText(task),
    data: task,
    sourceDeviceId: stringPayloadField(task.sourceDeviceId) || stringPayloadField(task.deviceId),
    sourceDeviceName: stringPayloadField(task.sourceDeviceName) || stringPayloadField(task.deviceName) || "RabiLink device",
    sourceDeviceKind: stringPayloadField(task.sourceDeviceKind),
    transport: stringPayloadField(task.transport)
  };
}

type RelayAttachment = Record<string, unknown>;

async function materializeRelayAttachments(task: RelayTask, taskId: string): Promise<RelayAttachment[]> {
  const input = Array.isArray(task.attachments) ? task.attachments.slice(0, 8) as RelayAttachment[] : [];
  if (!input.length) return [];
  const directory = path.join(config.memoryDataDir, "rabilink-media", taskId.replace(/[^a-zA-Z0-9._-]+/g, "_"));
  fs.mkdirSync(directory, { recursive: true });
  const output: RelayAttachment[] = [];
  for (const item of input) {
    const downloadPath = stringPayloadField(item.downloadPath);
    const fileName = path.basename(stringPayloadField(item.fileName) || `${stringPayloadField(item.id) || randomUUID()}.bin`).replace(/[^a-zA-Z0-9._-]+/g, "_");
    if (!downloadPath.startsWith("/api/rabilink/devices/media/")) continue;
    const response = await fetch(`${normalizedRelayBaseUrl()}${downloadPath}`, { headers: relayHeaders() });
    if (!response.ok) throw new Error(`RabiLink media download failed: ${response.status} ${response.statusText}`);
    const localPath = path.join(directory, fileName);
    fs.writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
    output.push({ ...item, fileName, localPath, downloadPath: undefined });
  }
  return output;
}

async function finishRelayTask(taskId: string, body: Record<string, unknown>): Promise<void> {
  await fetchRelayJsonReliably(`/worker/tasks/${encodeURIComponent(taskId)}/finish`, {
    method: "POST",
    headers: relayHeaders(true),
    body: JSON.stringify({ ...body, ...relayWorkerIdentityPayload() })
  });
}

function relayTaskField(task: RelayTask, key: string): string {
  return stringPayloadField(task[key]);
}

function relayTaskBoolean(task: RelayTask, key: string): boolean {
  return task[key] === true || String(task[key] || "").trim().toLowerCase() === "true";
}

function relayTaskProactivityPreference(task: RelayTask): "agent_decides" | "quiet" | "balanced" | "proactive" | undefined {
  const value = relayTaskField(task, "proactivityPreference");
  return value === "agent_decides" || value === "quiet" || value === "balanced" || value === "proactive"
    ? value
    : undefined;
}

function relayTaskNumber(task: RelayTask, key: string): number | undefined {
  const value = Number(task[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function relayTaskRecordedAt(task: RelayTask): string {
  const capturedAt = relayTaskNumber(task, "capturedAt");
  if (!capturedAt) return new Date().toISOString();
  const milliseconds = capturedAt < 10_000_000_000 ? capturedAt * 1000 : capturedAt;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function relayTaskSender(task: RelayTask): string {
  const source = task.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    return stringPayloadField((source as Record<string, unknown>).sender);
  }
  return "";
}

function isConversationReviewRequest(task: RelayTask): boolean {
  return relayTaskBoolean(task, "reviewRequested") || relayTaskField(task, "type") === "rabilink.review_request";
}

function isRecordOnlyObservation(task: RelayTask): boolean {
  return relayTaskField(task, "deliveryMode") === "observe" || relayTaskField(task, "type") === "rabilink.observation";
}

function wearableHealthObservationFromTask(task: RelayTask): WearableHealthObservationInput | null {
  const health = task.health;
  if (!health || typeof health !== "object" || Array.isArray(health)) return null;
  const value = health as Record<string, unknown>;
  if (!Array.isArray(value.samples) || value.samples.length === 0) return null;
  return {
    eventId: relayTaskField(task, "clientMessageId") || relayTaskField(task, "id"),
    capturedAt: relayTaskNumber(task, "capturedAt"),
    source: "rabilink-wearable",
    sourceDeviceId: relayTaskField(task, "sourceDeviceId"),
    sourceDeviceName: relayTaskField(task, "sourceDeviceName"),
    sourceDeviceKind: relayTaskField(task, "sourceDeviceKind") || "wearable",
    transport: relayTaskField(task, "transport") || "rabilink",
    policy: value.policy,
    samples: value.samples
  };
}

export type WearableHealthRelayTaskOptions = {
  enabled?: boolean;
  memoryDataDir?: string;
  agentRoleId?: string;
  managerPort?: string | number;
  forward?: typeof forwardMessage;
  appendLog?: typeof appendAdapterLog;
};

export function handleWearableHealthRelayTask(
  task: RelayTask,
  taskId: string,
  options: WearableHealthRelayTaskOptions = {}
): boolean {
  const observation = wearableHealthObservationFromTask(task);
  if (!observation) return false;
  const enabled = options.enabled ?? config.messageAdapterTypes.includes("wearable");
  const appendLog = options.appendLog ?? appendAdapterLog;
  if (!enabled) {
    appendLog("wearable", {
      level: "warning",
      event: "health_observation_ignored",
      message: "Structured wearable health observation was ignored because the wearable message adapter is disabled.",
      data: { taskId, sourceDeviceId: relayTaskField(task, "sourceDeviceId") }
    });
    return true;
  }
  const memoryDataDir = options.memoryDataDir ?? config.memoryDataDir;
  const agentRoleId = options.agentRoleId ?? config.agentRoleId;
  const managerPort = options.managerPort ?? process.env.GATEWAY_MANAGER_PORT ?? "8790";
  const deliver = options.forward ?? forwardMessage;
  const result = ingestWearableHealthObservation(memoryDataDir, observation);
  for (const alert of result.alerts) {
    const record = buildWearableHealthAlertRecord(alert, {
      agentRoleId,
      managerPort,
      sourceDeviceId: relayTaskField(task, "sourceDeviceId"),
      sourceDeviceName: relayTaskField(task, "sourceDeviceName"),
      sourceDeviceKind: relayTaskField(task, "sourceDeviceKind") || "wearable",
      transport: relayTaskField(task, "transport") || "rabilink"
    });
    deliver("wearable_health_alert", record, wearableHealthAlertTemplateValues(alert));
  }
  appendLog("wearable", {
    event: "health_observation_recorded",
    message: `Recorded ${result.accepted.length} wearable health samples; ${result.deduplicated.length} deduplicated; ${result.alerts.length} alerts.`,
    data: {
      taskId,
      eventId: result.eventId,
      sourceDeviceId: relayTaskField(task, "sourceDeviceId"),
      acceptedCount: result.accepted.length,
      deduplicatedCount: result.deduplicated.length,
      alertCount: result.alerts.length
    }
  });
  return true;
}

export function rabiLinkRelayTaskDisposition(task: RelayTask): RabiLinkRelayTaskDisposition {
  if (isConversationReviewRequest(task)) return "review_request";
  if (isRecordOnlyObservation(task)) return "record_only";
  return "direct";
}

function conversationSplitAfterMs(): number {
  const hours = Number(config.routeVariables.rabilinkConversationSplitAfterHours);
  return Number.isFinite(hours) && hours > 0
    ? Math.max(60 * 1000, hours * 60 * 60 * 1000)
    : DEFAULT_RABILINK_CONVERSATION_SPLIT_AFTER_MS;
}

export async function publishRabiLinkRelayMessage(
  text: string,
  options: {
    source?: string;
    taskId?: string;
    deliveryId?: string;
    proactive?: boolean;
    final?: boolean;
    metadata?: Record<string, unknown>;
    attachments?: Array<Record<string, unknown>>;
    targetDeviceIds?: string[];
    targetDeviceKinds?: string[];
    presentation?: Array<"text" | "tts" | "notification" | "haptic">;
    priority?: "quiet" | "normal" | "urgent";
    relay?: {
      enabled?: boolean;
      url?: string;
      token?: string;
      deviceId?: string;
      deviceGuid?: string;
    };
  } = {}
): Promise<Record<string, unknown>> {
  const value = text.trim();
  if (!value) throw new Error("RabiLink outbound message text is empty.");
  const relayUrl = options.relay?.url?.trim().replace(/\/+$/, "") || normalizedRelayBaseUrl();
  const relayToken = options.relay?.token?.trim() || config.rabiLinkRelayAppToken.trim();
  const relayEnabled = options.relay
    ? options.relay.enabled !== false && Boolean(relayUrl && relayToken)
    : config.rabiLinkRelayEnabled && Boolean(relayUrl && relayToken);
  if (!relayEnabled) {
    throw new Error("RabiLink Relay is not configured for outbound delivery.");
  }
  const deliveryId = options.deliveryId?.trim() || randomUUID();
  return fetchRelayJsonReliably("/worker/messages", {
    method: "POST",
    headers: {
      "X-RabiLink-Token": relayToken,
      "User-Agent": "RabiRoute/1.0",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: value,
      source: options.source?.trim() || "RabiRoute active intelligence",
      taskId: options.taskId?.trim() || "",
      deliveryId,
      proactive: options.proactive !== false,
      final: options.final !== false,
      metadata: options.metadata || {},
      routeProfileId: String(options.metadata?.routeProfileId || ""),
      attachments: options.attachments || [],
      targetDeviceIds: options.targetDeviceIds || [],
      targetDeviceKinds: options.targetDeviceKinds || [],
      presentation: options.presentation || [],
      priority: options.priority || "normal",
      deviceId: options.relay?.deviceId?.trim() || config.rabiLinkRelayDeviceId,
      deviceGuid: options.relay?.deviceGuid?.trim() || config.rabiLinkRelayDeviceGuid
    })
  }, relayUrl);
}

export async function uploadRabiLinkRelayAttachment(
  filePath: string,
  contentType: string,
  fileName: string,
  relay: { url?: string; token?: string } = {}
): Promise<Record<string, unknown>> {
  const relayUrl = relay.url?.trim().replace(/\/+$/, "") || normalizedRelayBaseUrl();
  const relayToken = relay.token?.trim() || config.rabiLinkRelayAppToken.trim();
  const data = fs.readFileSync(filePath);
  if (data.length > 64 * 1024 * 1024) throw new Error("RabiLink attachment exceeds 64 MiB.");
  const response = await fetch(`${relayUrl}/api/rabilink/devices/media?fileName=${encodeURIComponent(fileName)}`, {
    method: "POST",
    headers: { "X-RabiLink-Token": relayToken, "Content-Type": contentType || "application/octet-stream" },
    body: data
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.message || `RabiLink attachment upload failed: ${response.status}`));
  return body.attachment as Record<string, unknown>;
}

async function handleRelayTask(profile: WebhookAdapterProfile, webhookPath: string, task: RelayTask): Promise<void> {
  const taskId = relayTaskId(task);
  if (!taskId) {
    throw new Error("Relay task has no id.");
  }
  if (!acceptedRelayTasks.has(taskId)) {
    if (handleWearableHealthRelayTask(task, taskId)) {
      rememberAcceptedRelayTask(taskId);
      await finishRelayTask(taskId, {
        ok: true,
        status: "done",
        accepted: true
      });
      return;
    }
    const attachments = await materializeRelayAttachments(task, taskId);
    if (attachments.length) task.attachments = attachments;
    const text = relayTaskText(task);
    const clientMessageId = relayTaskField(task, "clientMessageId");
    const disposition = rabiLinkRelayTaskDisposition(task);
    const reviewRequested = disposition === "review_request";
    const recordOnly = disposition === "record_only";
    const preferenceObservation = relayTaskField(task, "type") === "rabilink.preference";
    const entryId = reviewRequested
      ? `rabilink-control:${clientMessageId || taskId}`
      : `rabilink-user:${clientMessageId || taskId}`;
    appendRabiLinkConversationEntry(config.memoryDataDir, {
      entryId,
      recordedAt: relayTaskRecordedAt(task),
      direction: reviewRequested ? "control" : "user_to_agent",
      kind: reviewRequested ? "review_request" : preferenceObservation ? "preference" : "voice_transcript",
      text,
      source: relayTaskField(task, "type") || "rabilink",
      sender: relayTaskField(task, "sender") || relayTaskSender(task) || "RabiLink device",
      messageId: clientMessageId || taskId,
      taskId,
      sessionId: relayTaskField(task, "sessionId"),
      sourceDeviceId: relayTaskField(task, "sourceDeviceId"),
      sourceDeviceName: relayTaskField(task, "sourceDeviceName") || "RabiLink device",
      sourceDeviceKind: relayTaskField(task, "sourceDeviceKind"),
      channelType: relayTaskField(task, "channelType"),
      transport: relayTaskField(task, "transport"),
      proactivityPreference: relayTaskProactivityPreference(task),
      preferenceKind: relayTaskField(task, "preferenceKind"),
      preferenceValue: relayTaskField(task, "preferenceValue"),
      explicitPreference: relayTaskBoolean(task, "explicitPreference"),
      routeProfileId: relayTaskField(task, "routeProfileId"),
      sequence: relayTaskNumber(task, "sequence"),
      capturedAt: relayTaskNumber(task, "capturedAt"),
      requiresReview: !reviewRequested && recordOnly,
      reviewRequested,
      attachments
    }, { splitAfterMs: conversationSplitAfterMs() });
    if (!reviewRequested) {
      const payload = payloadFromRelayTask(task, taskId);
      acceptWebhookPayload(
        profile,
        webhookPath,
        payload,
        Buffer.byteLength(JSON.stringify(payload)),
        { forward: !recordOnly }
      );
    }
    rememberAcceptedRelayTask(taskId);
    if (rabiLinkRelayTaskNeedsReviewWake(disposition)) {
      startDefaultRabiLinkConversationReviewer()?.wake();
    }
    appendAdapterLog(profile.type, {
      event: "relay_task_claimed",
      message: text.slice(0, 500),
      data: {
        taskId,
        relayUrl: normalizedRelayBaseUrl(),
        deliveryMode: disposition
      }
    });
  } else {
    appendAdapterLog(profile.type, {
      event: "relay_task_finish_retried",
      message: "Relay task was already accepted locally; retrying only its remote completion acknowledgement.",
      data: { taskId, relayUrl: normalizedRelayBaseUrl() }
    });
  }
  await finishRelayTask(taskId, {
    ok: true,
    status: "done",
    accepted: true
  });
}

async function claimRelayTask(): Promise<RelayTask | null> {
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.rabiLinkRelayDeviceId,
    deviceGuid: config.rabiLinkRelayDeviceGuid,
    deviceName: hostname(),
    waitMs: "0"
  });
  const body = await fetchRelayJson(`/worker/tasks?${params}`, {
    method: "GET",
    headers: relayHeaders()
  });
  return taskFromClaimResponse(body);
}

export function startRabiLinkRelayWorker(profile: WebhookAdapterProfile, webhookPath: string): void {
  if (!config.rabiLinkRelayEnabled || !normalizedRelayBaseUrl()) {
    patchRelayStatus(profile, { relayWorker: "disabled", message: "RabiLink Relay worker is disabled." });
    return;
  }
  const workerKey = `${normalizedRelayBaseUrl()}:${config.rabiLinkRelayDeviceId}`;
  if (runningRelayWorkers.has(workerKey)) {
    patchRelayStatus(profile, {
      relayWorker: "running",
      relayUrl: normalizedRelayBaseUrl(),
      relayDeviceId: config.rabiLinkRelayDeviceId,
      message: "RabiLink Relay worker is shared with another device message adapter."
    });
    return;
  }
  runningRelayWorkers.add(workerKey);
  startDefaultRabiLinkConversationReviewer();
  let draining: Promise<void> | null = null;
  const drainAvailableTasks = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      while (true) {
        const task = await claimRelayTask();
        if (!task) return;
        await handleRelayTask(profile, webhookPath, task);
      }
    })().finally(() => {
      draining = null;
    });
    return draining;
  };
  const connectEventStream = async (): Promise<void> => {
    patchRelayStatus(profile, {
      relayWorker: "connecting",
      relayUrl: normalizedRelayBaseUrl(),
      relayDeviceId: config.rabiLinkRelayDeviceId,
      message: "RabiLink Relay worker 正在连接事件流。"
    });
    try {
      await consumeRelayEvents((eventType) => {
        if (eventType !== "ready" && eventType !== "task_available") return;
        patchRelayStatus(profile, {
          status: "running",
          relayWorker: "running",
          message: "RabiLink Relay 事件流已连接。"
        });
        void drainAvailableTasks().catch((error) => {
          appendAdapterLog(profile.type, {
            level: "error",
            event: "relay_event_drain_failed",
            message: error instanceof Error ? error.message : String(error)
          });
        });
      });
      throw new Error("RabiLink Relay event stream closed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      patchRelayStatus(profile, { status: "error", relayWorker: "error", message });
      appendAdapterLog(profile.type, {
        level: "error",
        event: "relay_event_stream_error",
        message,
        data: {
          relayUrl: normalizedRelayBaseUrl(),
          relayDeviceId: config.rabiLinkRelayDeviceId
        }
      });
      await sleep(3000);
      void connectEventStream();
    }
  };
  void connectEventStream();
}
