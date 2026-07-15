import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { appendAdapterLog } from "../history.js";
import {
  appendRabiLinkConversationEntry,
  DEFAULT_RABILINK_CONVERSATION_SPLIT_AFTER_MS
} from "../rabilinkConversationLedger.js";
import { startDefaultRabiLinkConversationReviewer } from "../rabilinkConversationReviewer.js";
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
    text: relayTaskText(task),
    data: task,
    sourceDeviceId: stringPayloadField(task.sourceDeviceId) || stringPayloadField(task.deviceId),
    sourceDeviceName: stringPayloadField(task.sourceDeviceName) || stringPayloadField(task.deviceName) || "RabiLink device",
    sourceDeviceKind: stringPayloadField(task.sourceDeviceKind),
    transport: stringPayloadField(task.transport)
  };
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
      targetDeviceIds: options.targetDeviceIds || [],
      targetDeviceKinds: options.targetDeviceKinds || [],
      presentation: options.presentation || [],
      priority: options.priority || "normal",
      deviceId: options.relay?.deviceId?.trim() || config.rabiLinkRelayDeviceId,
      deviceGuid: options.relay?.deviceGuid?.trim() || config.rabiLinkRelayDeviceGuid
    })
  }, relayUrl);
}

async function handleRelayTask(profile: WebhookAdapterProfile, webhookPath: string, task: RelayTask): Promise<void> {
  const taskId = relayTaskId(task);
  if (!taskId) {
    throw new Error("Relay task has no id.");
  }
  if (!acceptedRelayTasks.has(taskId)) {
    const text = relayTaskText(task);
    const clientMessageId = relayTaskField(task, "clientMessageId");
    const disposition = rabiLinkRelayTaskDisposition(task);
    const reviewRequested = disposition === "review_request";
    const recordOnly = disposition === "record_only";
    const entryId = reviewRequested
      ? `rabilink-control:${clientMessageId || taskId}`
      : `rabilink-user:${clientMessageId || taskId}`;
    appendRabiLinkConversationEntry(config.memoryDataDir, {
      entryId,
      recordedAt: relayTaskRecordedAt(task),
      direction: reviewRequested ? "control" : "user_to_agent",
      kind: reviewRequested ? "review_request" : "voice_transcript",
      text,
      source: relayTaskField(task, "type") || "rabilink",
      sender: relayTaskSender(task) || "Rokid Glass",
      messageId: clientMessageId || taskId,
      taskId,
      sessionId: relayTaskField(task, "sessionId"),
      sourceDeviceId: relayTaskField(task, "sourceDeviceId"),
      sourceDeviceName: relayTaskField(task, "sourceDeviceName") || "RabiLink device",
      sourceDeviceKind: relayTaskField(task, "sourceDeviceKind"),
      transport: relayTaskField(task, "transport"),
      sequence: relayTaskNumber(task, "sequence"),
      capturedAt: relayTaskNumber(task, "capturedAt"),
      requiresReview: !reviewRequested && recordOnly,
      reviewRequested
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
    startDefaultRabiLinkConversationReviewer()?.wake();
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
  const waitMs = config.rabiLinkRelayClaimWaitMs;
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.rabiLinkRelayDeviceId,
    deviceGuid: config.rabiLinkRelayDeviceGuid,
    deviceName: hostname(),
    waitMs: String(waitMs)
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
  const workerKey = `${profile.type}:${normalizedRelayBaseUrl()}:${config.rabiLinkRelayDeviceId}`;
  if (runningRelayWorkers.has(workerKey)) return;
  runningRelayWorkers.add(workerKey);
  startDefaultRabiLinkConversationReviewer();
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
