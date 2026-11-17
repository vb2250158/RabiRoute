import { getTimeoutMs } from "@rabiroute/host-api/shared/timeoutSettings";
/**
 * Sends through the original native session's exact-ID reply endpoint.
 * Native permission mode and queue remain owned by WorkBuddy. A successful
 * reply acknowledges admission, including queued work; it does not prove
 * completion or live rendering in the desktop window.
 */

import fs from "node:fs";
import path from "node:path";
import { applicationRuntimeLayout } from "@rabiroute/host-api/shared/runtimeLayout";
import {
  assertWorkbuddyLoopback,
  invalidateWorkbuddyGatewayPassword,
  discoverWorkbuddyOwners,
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

export type WorkbuddyDeliveryRequest = {
  assertAuthorized?: () => void | Promise<void>;
  sessionId: string;
  text: string;
  /** Native gateway-compatible file references, read through WorkBuddy's Read tool. */
  imagePaths?: string[];
  endpoint: string;
  fetchImpl?: typeof fetch;
};

export type WorkbuddyDeliveryResult = { ok: true; sessionId: string; accepted: true };

export class WorkbuddyDeliveryError extends Error {
  readonly outcome: "rejected" | "unknown" | "unreachable" | "unauthorized";
  constructor(message: string, outcome: WorkbuddyDeliveryError["outcome"]) {
    super(message);
    this.name = "WorkbuddyDeliveryError";
    this.outcome = outcome;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Preserve the native generic gateway's local-image reference semantics. */
export function prepareWorkbuddyReplyText(text: string, imagePaths: string[] = []): string {
  if (!text.trim()) throw new WorkbuddyDeliveryError("WorkBuddy 投递正文为空。", "rejected");
  const references = imagePaths.map(file => {
    try {
      if (!path.isAbsolute(file) || /[\r\n]/.test(file) || !fs.statSync(file).isFile()) throw new Error();
      fs.accessSync(file, fs.constants.R_OK);
    } catch { throw new WorkbuddyDeliveryError("WorkBuddy 图片附件不可用。", "rejected"); }
    return `- [图片] ${path.basename(file)} （本地路径，可用 Read）: ${file}`;
  });
  return (text + (references.length ? `\n\n附件列表（请按需使用 Read / WebFetch 等工具查看）：\n${references.join("\n")}` : "")).trim();
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
  const text = prepareWorkbuddyReplyText(typeof request.text === "string" ? request.text : "", request.imagePaths);
  if (!sessionId) throw new WorkbuddyDeliveryError("WorkBuddy 投递缺少任务 ID。", "rejected");

  const origin = assertWorkbuddyLoopback(request.endpoint);
  const fetchImpl = request.fetchImpl ?? fetch;
  const password = await workbuddyGatewayPassword({ endpoint: origin }).catch(error => {
    if (error instanceof WorkbuddyCredentialError) {
      throw new WorkbuddyDeliveryError(error.message, "unauthorized");
    }
    throw error;
  });

  await request.assertAuthorized?.();
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/v1/sessions/${encodeURIComponent(sessionId)}/reply`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(getTimeoutMs("backend.workbuddySessionBridge.REQUEST_TIMEOUT_MS", REQUEST_TIMEOUT_MS)),
      headers: {
        Authorization: `Bearer ${password}`,
        "X-CodeBuddy-Request": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } })?.cause?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new WorkbuddyDeliveryError("WorkBuddy 会话网关连接未建立，本次投递未发出。", "unreachable");
    }
    throw new WorkbuddyDeliveryError(
      "WorkBuddy 网关通信中断，投递结果待确认；请核对原任务和原回执。",
      "unknown"
    );
  }

  if (response.status === 401 || response.status === 403) {
    invalidateWorkbuddyGatewayPassword();
    throw new WorkbuddyDeliveryError(
      "WorkBuddy 会话网关拒绝凭据；请重新发现原任务的连接，本次投递未被接受。",
      "unauthorized"
    );
  }

  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    if (response.status >= 500 || response.status === 408 || response.status >= 300 && response.status < 400) {
      throw new WorkbuddyDeliveryError(
        `WorkBuddy 网关返回 HTTP ${response.status}，投递结果待确认；请核对原任务和原回执。`,
        "unknown"
      );
    }
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

  if (!parsed || typeof parsed !== "object" ||
    (parsed as { data?: { delivered?: unknown } }).data?.delivered !== true) {
    throw new WorkbuddyDeliveryError("WorkBuddy 未返回原生任务接收回执；请核对原任务和原回执。", "unknown");
  }
  return { ok: true, sessionId, accepted: true };
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
    || path.join(applicationRuntimeLayout(process.env).stateRoot, "data", "route", "main", "adapterConfig.json");
}

/**
 * Read the WorkBuddy binding. Returns null for deployments that do not bind a
 * WorkBuddy task, so the adapter stays inert instead of guessing a target.
 */
export function readWorkbuddyPrimaryBinding(
  routeConfigPath: string = workbuddyRouteConfigPath(), configuration?: Record<string, unknown>
): WorkbuddyPrimaryBinding | null {
  try {
    const parsed = configuration ?? JSON.parse(fs.readFileSync(routeConfigPath, "utf8")) as Record<string, unknown>;
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
  binding: WorkbuddyPrimaryBinding,
  descriptors?: ReturnType<typeof listWorkbuddySessionDescriptors>
): { task: WorkbuddyTask; endpoint: string } {
  const resolution = resolveWorkbuddyTask({
    sessionId: binding.sessionId,
    sessionName: binding.sessionName,
    workspace: binding.cwd,
    descriptors
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

export async function ensureWorkbuddyOwnerConnected(binding: WorkbuddyPrimaryBinding) {
  const descriptors = listWorkbuddySessionDescriptors().filter(owner => owner.sessionId === binding.sessionId);
  const connected = await discoverWorkbuddyOwners(descriptors);
  return ensureWorkbuddyDeliverable(binding, connected);
}

/**
 * The WorkBuddy adapter entry point, mirroring `notifyDshSession`. Resolves the
 * binding, validates the live owner, then delivers on the single real path.
 */
export async function notifyWorkbuddySession(
  message: string,
  _options: Record<string, never> = {},
  configuration?: Record<string, unknown>
): Promise<{ sessionId: string; accepted: true }> {
  const binding = readWorkbuddyPrimaryBinding(undefined, configuration);
  if (!binding) {
    throw new WorkbuddyDeliveryError(
      "当前路由没有配置 WorkBuddy 任务绑定；请先在设置里选择任务并保存。",
      "rejected"
    );
  }
  const { task, endpoint } = await ensureWorkbuddyOwnerConnected(binding);
  const result = await deliverWorkbuddyMessage({
    sessionId: task.id,
    text: message,
    endpoint
  });
  return { sessionId: task.id, accepted: result.accepted };
}

/** Normalized workspace helper re-exported for settings save-time validation. */
export function workbuddyWorkspaceKey(value: string | undefined | null): string {
  return normalizeWorkbuddyWorkspace(value);
}
