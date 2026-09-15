/**
 * WorkBuddy session delivery bridge.
 *
 * This is the ONLY code path that may put real message text into a WorkBuddy
 * task. Everything else (scanning, health, resolver) is read-only and must
 * never carry a body.
 *
 * Verified on WorkBuddy 5.5.6 (see docs/workbuddy-agent-adapter-plan.md):
 *
 *   POST <endpoint>/api/v1/runs
 *     Authorization: Bearer <gateway password>
 *     { id, type, source: { platform, sender:{id}, conversation:{id} }, payload:{ text } }
 *
 * `source.conversation.id` IS the session routing key: the gateway calls
 * `getOrCreateSession(source.conversation.id)`, so pinning it to the bound
 * full session id gives same-id redelivery natively (no new task is created).
 *
 * `type` and the message `id` are mandatory; the bundled OpenAPI spec omits
 * them and returns `400 Invalid generic message format` if either is missing.
 * Reply text lands in `<home>/projects/<project-slug>/<sessionId>.jsonl` as a
 * normal user turn executed by the same desktop task owner.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertWorkbuddyLoopback,
  invalidateWorkbuddyGatewayPassword,
  workbuddyGatewayPassword,
  WorkbuddyCredentialError
} from "./workbuddyHttpAuth.js";
import {
  listWorkbuddySessionDescriptors,
  normalizeWorkbuddyWorkspace,
  resolveWorkbuddyTask,
  sameWorkbuddyWorkspace,
  type WorkbuddyTask
} from "./workbuddySessionStore.js";

/** One delivery attempt. Text is the only field that may vary between runs. */
export type WorkbuddyDeliveryRequest = {
  /** Bound task id; becomes `source.conversation.id` (the routing key). */
  sessionId: string;
  /** Message body. Never logged, never persisted by this module. */
  text: string;
  /** Local loopback gateway endpoint from the live session descriptor. */
  endpoint: string;
  /** Stable sender identifier shown to the task owner. */
  senderId?: string;
  /** Platform label surfaced in the task's message source. */
  platform?: string;
  /** Maximum time to wait for the task to stop reporting `active`. */
  settleTimeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type WorkbuddyDeliveryResult = {
  ok: true;
  runId: string;
  /** True when the gateway reported the turn finished before the timeout. */
  settled: boolean;
};

export class WorkbuddyDeliveryError extends Error {
  readonly outcome: "rejected" | "unknown" | "unreachable" | "unauthorized";
  constructor(message: string, outcome: WorkbuddyDeliveryError["outcome"]) {
    super(message);
    this.name = "WorkbuddyDeliveryError";
    this.outcome = outcome;
  }
}

const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 30_000;

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Extract the run id from either the flat or `{data:...}` response shape. */
export function parseWorkbuddyRunId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const direct = textOf(record.runId);
  if (direct) return direct;
  const nested = record.data;
  if (nested && typeof nested === "object") return textOf((nested as Record<string, unknown>).runId);
  return "";
}

export function parseWorkbuddyRunActive(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : record;
  return typeof data.active === "boolean" ? data.active : null;
}

/**
 * Deliver one message body into the bound WorkBuddy task.
 *
 * Fails closed: an unreachable gateway, a 401, or a rejected message all throw.
 * A request that may have been accepted but whose result is unknown is reported
 * as `unknown` so the caller checks the receipt BEFORE retrying instead of
 * duplicating a turn.
 */
export async function deliverWorkbuddyMessage(
  request: WorkbuddyDeliveryRequest
): Promise<WorkbuddyDeliveryResult> {
  const sessionId = textOf(request.sessionId);
  const text = typeof request.text === "string" ? request.text : "";
  if (!sessionId) throw new WorkbuddyDeliveryError("WorkBuddy 投递缺少任务 ID。", "rejected");
  // Whitespace-only bodies must not reach the gateway: an empty turn would be
  // accepted and would still consume the task owner.
  if (!text.trim()) throw new WorkbuddyDeliveryError("WorkBuddy 投递正文为空。", "rejected");

  const origin = assertWorkbuddyLoopback(request.endpoint);
  const fetchImpl = request.fetchImpl ?? fetch;
  const password = await workbuddyGatewayPassword().catch(error => {
    if (error instanceof WorkbuddyCredentialError) {
      throw new WorkbuddyDeliveryError(error.message, "unauthorized");
    }
    throw error;
  });

  const body = {
    id: randomUUID(),
    type: "message",
    source: {
      platform: textOf(request.platform) || "rabiroute",
      sender: { id: textOf(request.senderId) || "rabiroute" },
      conversation: { id: sessionId, type: "direct" }
    },
    payload: { text }
  };

  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v1/runs`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${password}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
    // No proof the gateway accepted anything: safe to report as unreachable.
    throw new WorkbuddyDeliveryError(
      "WorkBuddy 会话网关不可达；本次投递未发出，可安全重试。",
      "unreachable"
    );
  }

  if (response.status === 401 || response.status === 403) {
    invalidateWorkbuddyGatewayPassword();
    throw new WorkbuddyDeliveryError(
      "WorkBuddy 会话网关拒绝凭据；请更新本地凭据文件后重试，本次投递未被接受。",
      "unauthorized"
    );
  }

  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    throw new WorkbuddyDeliveryError(
      `WorkBuddy 会话网关拒绝投递（HTTP ${response.status}）；本次投递未生效。`,
      "rejected"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 2xx without a parseable body: the turn may still be running.
    throw new WorkbuddyDeliveryError(
      "WorkBuddy 会话网关已接受请求但未返回可解析的回执；请先在目标任务中核对，再决定是否重试。",
      "unknown"
    );
  }

  const runId = parseWorkbuddyRunId(parsed);
  if (!runId) {
    throw new WorkbuddyDeliveryError(
      "WorkBuddy 会话网关已接受请求但未返回 runId；请先在目标任务中核对，再决定是否重试。",
      "unknown"
    );
  }

  const settled = await waitForWorkbuddyTurn(origin, runId, password, {
    fetchImpl,
    timeoutMs: Math.max(0, request.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS)
  });
  return { ok: true, runId, settled };
}

/**
 * Poll `/runs/{runId}` until the turn stops reporting `active`.
 * Returns false on timeout — the message was accepted, it is simply still
 * running. That is not an error and must not trigger a second delivery.
 */
export async function waitForWorkbuddyTurn(
  endpoint: string,
  runId: string,
  password: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<boolean> {
  const origin = assertWorkbuddyLoopback(endpoint);
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
  // First poll is immediate: short turns finish long before the deadline.
  for (;;) {
    try {
      const response = await fetchImpl(`${origin}/api/v1/runs/${encodeURIComponent(runId)}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${password}` }
      });
      if (response.ok) {
        const active = parseWorkbuddyRunActive(await response.json().catch(() => null));
        if (active === false) return true;
      }
    } catch {
      // A transient poll failure does not change the delivery outcome.
    }
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(250, deadline - Date.now()))));
  }
}

/**
 * The WorkBuddy binding lives in the route's adapterConfig.json, mirroring the
 * DSH shape: task id + display name + workspace + last-known endpoint. The
 * credential is deliberately absent — it belongs in the local ignored file read
 * by `workbuddyHttpAuth.ts`.
 */
export type WorkbuddyPrimaryBinding = {
  sessionId: string;
  sessionName: string;
  cwd: string;
  endpoint: string;
};

export function workbuddyRouteConfigPath(): string {
  return process.env.RABI_WORKBUDDY_ROUTE_CONFIG_PATH
    || path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "data",
      "route",
      "main",
      "adapterConfig.json"
    );
}

/**
 * Read the WorkBuddy binding. Returns null for deployments that do not bind a
 * WorkBuddy task, so the adapter stays inert instead of guessing a target.
 */
export function readWorkbuddyPrimaryBinding(
  routeConfigPath: string = workbuddyRouteConfigPath()
): WorkbuddyPrimaryBinding | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(routeConfigPath, "utf8")) as Record<string, unknown>;
    const sessionId = typeof parsed.workbuddySessionId === "string" ? parsed.workbuddySessionId.trim() : "";
    const cwd = typeof parsed.workbuddyCwd === "string" ? parsed.workbuddyCwd.trim() : "";
    if (!sessionId || !cwd) return null;
    const sessionName = typeof parsed.workbuddySessionName === "string" && parsed.workbuddySessionName.trim()
      ? parsed.workbuddySessionName.trim()
      : "";
    const configuredEndpoint = typeof parsed.workbuddyEndpoint === "string" ? parsed.workbuddyEndpoint.trim() : "";
    // The desktop port changes on every launch, so a persisted endpoint is only
    // a fallback: the live session descriptor always wins when it exists.
    const live = listWorkbuddySessionDescriptors().find(descriptor =>
      descriptor.sessionId === sessionId && descriptor.deliverable && descriptor.endpoint);
    const endpoint = live?.endpoint || configuredEndpoint;
    if (!endpoint) return null;
    return { sessionId, sessionName, cwd, endpoint };
  } catch {
    return null;
  }
}

/**
 * Resolve the bound task through the standard resolver and re-check liveness
 * immediately before delivery. A stale owner, a workspace mismatch or an
 * archived id all fail closed; nothing here starts a replacement runtime.
 */
export function ensureWorkbuddyDeliverable(
  binding: WorkbuddyPrimaryBinding
): { task: WorkbuddyTask; endpoint: string } {
  const resolution = resolveWorkbuddyTask({
    sessionId: binding.sessionId,
    sessionName: binding.sessionName,
    workspace: binding.cwd
  });
  if (resolution.outcome === "archived") {
    throw new WorkbuddyDeliveryError(
      "绑定的 WorkBuddy 任务已归档；请在设置中重新绑定后再投递。",
      "rejected"
    );
  }
  if (resolution.outcome !== "bound") {
    const reason = resolution.outcome === "invalid"
      ? resolution.reason
      : "绑定的 WorkBuddy 任务无法唯一定位；请在设置中重新选择。";
    throw new WorkbuddyDeliveryError(reason, "rejected");
  }
  const task = resolution.task;
  if (!task.live) {
    throw new WorkbuddyDeliveryError(
      "绑定的 WorkBuddy 任务当前没有存活的会话进程；请在该任务中重新打开会话后再投递。",
      "unreachable"
    );
  }
  if (task.live.stale) {
    throw new WorkbuddyDeliveryError(
      "绑定的 WorkBuddy 会话心跳已过期，任务 owner 可能已退出；本次投递已取消。",
      "unreachable"
    );
  }
  if (task.workspace && !sameWorkbuddyWorkspace(task.workspace, binding.cwd)) {
    throw new WorkbuddyDeliveryError(
      `绑定工作目录 ${binding.cwd} 与任务实际目录 ${task.workspace} 不一致，已停止投递。`,
      "rejected"
    );
  }
  return { task, endpoint: task.live.endpoint };
}

/**
 * The WorkBuddy adapter entry point, mirroring `notifyDshSession`. Resolves the
 * binding, validates the live owner, then delivers on the single real path.
 */
export async function notifyWorkbuddySession(
  message: string,
  options: { senderId?: string; settleTimeoutMs?: number } = {}
): Promise<{ sessionId: string; runId: string }> {
  const binding = readWorkbuddyPrimaryBinding();
  if (!binding) {
    throw new WorkbuddyDeliveryError(
      "当前路由没有配置 WorkBuddy 任务绑定；请先在设置里选择任务并保存。",
      "rejected"
    );
  }
  const { task, endpoint } = ensureWorkbuddyDeliverable(binding);
  const result = await deliverWorkbuddyMessage({
    sessionId: task.id,
    text: message,
    endpoint,
    ...(options.senderId ? { senderId: options.senderId } : {}),
    ...(options.settleTimeoutMs !== undefined ? { settleTimeoutMs: options.settleTimeoutMs } : {})
  });
  return { sessionId: task.id, runId: result.runId };
}

/** Normalized workspace helper re-exported for settings save-time validation. */
export function workbuddyWorkspaceKey(value: string | undefined | null): string {
  return normalizeWorkbuddyWorkspace(value);
}
