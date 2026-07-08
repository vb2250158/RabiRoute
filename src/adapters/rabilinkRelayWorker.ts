import { hostname } from "node:os";
import { config } from "../config.js";
import { appendAdapterLog } from "../history.js";
import {
  acceptWebhookPayload,
  nestedTextFromData,
  patchRelayStatus,
  stringPayloadField,
  type WebhookAdapterProfile,
  type WebhookPayload
} from "./webhookAdapter.js";
import {
  rabiLinkReplyLogFilePath,
  readJsonlTail,
  replyIsFinal,
  replyKey,
  replyMatchesTask,
  replyText
} from "./rabilinkReplies.js";

type RelayTask = Record<string, unknown>;
type RelayWebguiRequest = {
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

const runningRelayWorkers = new Set<string>();

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

function webguiRequestsFromClaimResponse(body: Record<string, unknown>): RelayWebguiRequest[] {
  const requests = Array.isArray(body.requests) ? body.requests : [];
  return requests.filter((item): item is RelayWebguiRequest => Boolean(item && typeof item === "object" && !Array.isArray(item)));
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

async function appendRelayMessage(taskId: string, text: string, raw: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify({ text, raw, ...relayWorkerIdentityPayload() });
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
    body: JSON.stringify({ ...body, ...relayWorkerIdentityPayload() })
  });
}

async function finishRelayWebguiRequest(requestId: string, body: Record<string, unknown>): Promise<void> {
  await fetchRelayJson(`/worker/webgui-requests/${encodeURIComponent(requestId)}/response`, {
    method: "POST",
    headers: relayHeaders(true),
    body: JSON.stringify({ ...body, ...relayWorkerIdentityPayload() })
  });
}

function normalizedRelayWebguiBaseUrl(): string {
  return config.rabiLinkRelayWebguiUrl.trim().replace(/\/+$/, "") || "http://127.0.0.1:8790";
}

function safeWebguiLocalUrl(pathname: string): string {
  const base = normalizedRelayWebguiBaseUrl();
  const localUrl = new URL(pathname && pathname.startsWith("/") ? pathname : `/${pathname || ""}`, base);
  const baseUrl = new URL(base);
  localUrl.protocol = baseUrl.protocol;
  localUrl.host = baseUrl.host;
  return localUrl.toString();
}

function relayWebguiRequestId(request: RelayWebguiRequest): string {
  return stringPayloadField(request.id);
}

function compactRelayWebguiResponse(method: string, localPath: string, statusCode: number, body: Buffer): Buffer {
  const upperMethod = method.toUpperCase();
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(upperMethod)) return body;
  if (!localPath.startsWith("/gateways") && !localPath.startsWith("/manager-config")) return body;
  if (statusCode < 200 || statusCode >= 300) return body;
  return Buffer.from(JSON.stringify({ code: 0, ok: true }), "utf8");
}

async function handleRelayWebguiRequest(request: RelayWebguiRequest): Promise<void> {
  const requestId = relayWebguiRequestId(request);
  if (!requestId) return;
  try {
    const method = stringPayloadField(request.method).toUpperCase() || "GET";
    const localPath = stringPayloadField(request.path) || "/";
    const localUrl = safeWebguiLocalUrl(localPath);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      const lower = key.toLowerCase();
      if (!["accept", "content-type", "user-agent"].includes(lower)) continue;
      headers[lower] = String(value || "");
    }
    const body = request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined;
    const response = await fetch(localUrl, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body
    });
    const rawResponseBuffer = Buffer.from(await response.arrayBuffer());
    const responseBuffer = compactRelayWebguiResponse(method, localPath, response.status, rawResponseBuffer);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    await finishRelayWebguiRequest(requestId, {
      ok: true,
      statusCode: response.status,
      headers: responseHeaders,
      bodyBase64: responseBuffer.toString("base64")
    });
  } catch (error) {
    await finishRelayWebguiRequest(requestId, {
      ok: false,
      statusCode: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
      bodyBase64: Buffer.from(error instanceof Error ? error.message : String(error), "utf8").toString("base64"),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function streamRepliesToRelay(taskId: string): Promise<{ deliveredCount: number; sawFinal: boolean }> {
  const delivered = new Set<string>();
  let lastActivityAt = Date.now();
  let sawFinal = false;
  let deliveredCount = 0;
  const idleTimeoutMs = config.rabiLinkRelayReplyIdleTimeoutMs;
  while (Date.now() - lastActivityAt <= idleTimeoutMs) {
    const rows = readJsonlTail(rabiLinkReplyLogFilePath(), 500, "").filter((row) => replyMatchesTask(row, taskId));
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

async function claimRelayWebguiRequests(): Promise<RelayWebguiRequest[]> {
  const waitMs = config.rabiLinkRelayClaimWaitMs;
  const params = new URLSearchParams({
    limit: "1",
    deviceId: config.rabiLinkRelayDeviceId,
    deviceGuid: config.rabiLinkRelayDeviceGuid,
    deviceName: hostname(),
    waitMs: String(waitMs)
  });
  const body = await fetchRelayJson(`/worker/webgui-requests?${params}`, {
    method: "GET",
    headers: relayHeaders()
  });
  return webguiRequestsFromClaimResponse(body);
}

export function startRabiLinkRelayWebguiWorker(profile: WebhookAdapterProfile): void {
  if (!config.rabiLinkRelayEnabled || !normalizedRelayBaseUrl()) return;
  const workerKey = `${profile.type}:webgui:${normalizedRelayBaseUrl()}:${config.rabiLinkRelayDeviceGuid || config.rabiLinkRelayDeviceId}`;
  if (runningRelayWorkers.has(workerKey)) return;
  runningRelayWorkers.add(workerKey);
  void (async () => {
    while (true) {
      try {
        const requests = await claimRelayWebguiRequests();
        for (const request of requests) {
          await handleRelayWebguiRequest(request);
        }
      } catch (error) {
        appendAdapterLog(profile.type, {
          level: "error",
          event: "relay_webgui_worker_error",
          message: error instanceof Error ? error.message : String(error),
          data: {
            relayUrl: normalizedRelayBaseUrl(),
            relayDeviceId: config.rabiLinkRelayDeviceId,
            relayDeviceGuid: config.rabiLinkRelayDeviceGuid,
            localWebguiUrl: normalizedRelayWebguiBaseUrl()
          }
        });
        await sleep(3000);
      }
    }
  })();
}

export function startRabiLinkRelayWorker(profile: WebhookAdapterProfile, webhookPath: string): void {
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
