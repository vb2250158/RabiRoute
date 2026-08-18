/**
 * DSH (DeepSeek Harness) session bridge — the DSH-side counterpart of the
 * Codex Desktop bridge. The XinghaiBuilder route can bind its primary persona
 * (主人格) to a local DSH session; incoming RabiRoute deliveries are then
 * injected into that live session through the DSH apiproxy HTTP API
 * (`POST /api/session.prompt`, `POST /api/session.list`).
 *
 * The DSH binding lives in the route's adapterConfig.json (dshSessionId +
 * dshSessionName + dshCwd + dshBaseUrl), which keeps a single source of truth
 * shared with the DSH-side preset plugin (`rabi-tools-v2.js` reads the same
 * file). This module deliberately reads the file at call time instead of
 * plumbing the binding through every delivery call site.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_DSH_BASE_URL = "http://127.0.0.1:3080";
export const DEFAULT_DSH_SESSION_NAME = "星海建造师（DSH 主人格）";
export const DSH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const dshSessionIdPattern = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDshSessionId(value: string): boolean {
  return dshSessionIdPattern.test(String(value || "").trim());
}

export type DshPrimaryBinding = {
  sessionId: string;
  sessionName: string;
  cwd: string;
  baseUrl: string;
};

export function dshRouteConfigPath(): string {
  return process.env.RABI_DSH_ROUTE_CONFIG_PATH
    || path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "data",
      "route",
      "XinghaiBuilder-main",
      "adapterConfig.json"
    );
}

/**
 * Read the DSH primary binding from the route adapterConfig.json. Returns null
 * when the route has no complete DSH primary binding (pure Codex deployment).
 */
export function readDshPrimaryBinding(routeConfigPath: string = dshRouteConfigPath()): DshPrimaryBinding | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(routeConfigPath, "utf8")) as Record<string, unknown>;
    const sessionId = typeof parsed.dshSessionId === "string" ? parsed.dshSessionId.trim() : "";
    const cwd = typeof parsed.dshCwd === "string" ? parsed.dshCwd.trim() : "";
    if (!sessionId || !isDshSessionId(sessionId) || !cwd) return null;
    const baseUrl = typeof parsed.dshBaseUrl === "string" && parsed.dshBaseUrl.trim()
      ? parsed.dshBaseUrl.trim().replace(/\/+$/, "")
      : DEFAULT_DSH_BASE_URL;
    const sessionName = typeof parsed.dshSessionName === "string" && parsed.dshSessionName.trim()
      ? parsed.dshSessionName.trim()
      : DEFAULT_DSH_SESSION_NAME;
    return { sessionId, sessionName, cwd, baseUrl };
  } catch {
    return null;
  }
}

type DshRpcOk<T> = { ok: true; value: T };
type DshRpcError = { ok: false; error: { code?: string; message?: string } };

async function dshRpc<T>(baseUrl: string, method: string, payload: unknown): Promise<DshRpcOk<T> | DshRpcError> {
  const rpcId = randomUUID();
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload })
  });
  if (!response.ok) {
    throw new Error(`DSH ${method} transport failed with HTTP ${response.status}.`);
  }
  const full = await response.json() as {
    rpcId?: unknown;
    result?: { ok?: boolean; value?: unknown; error?: unknown };
  };
  if (full.rpcId !== rpcId) {
    throw new Error(`DSH ${method} rpcId mismatch (possible cross-talk).`);
  }
  const result = full.result;
  if (!result || result.ok !== true) {
    const error = result?.error && typeof result.error === "object"
      ? result.error as Record<string, unknown>
      : {};
    return {
      ok: false,
      error: {
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.message === "string" ? error.message : JSON.stringify(error)
      }
    };
  }
  return { ok: true, value: result.value as T };
}

type DshSessionListItem = {
  sessionId?: string;
  updatedAt?: number;
  running?: boolean;
  cwd?: string;
  projections?: { values?: { title?: string } };
};

/**
 * Read one DSH session through the apiproxy. The result shape mirrors
 * Codex thread reads so existing consumers (agentThreads read, thread
 * summaries, agent-to-agent source verification) work unchanged.
 */
export async function readDshSession(
  sessionId: string,
  baseUrl: string = DEFAULT_DSH_BASE_URL
): Promise<{
  id: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  archived: boolean;
  source: string;
  active: boolean;
  status: { type: "active" | "idle" };
}> {
  const result = await dshRpc<{ items?: DshSessionListItem[] }>(baseUrl, "session.list", {});
  if (!result.ok) {
    throw new Error(`DSH session read failed: ${result.error.message || result.error.code || "unknown error"}`);
  }
  const item = (result.value.items || []).find((candidate) => candidate.sessionId === sessionId);
  if (!item) {
    throw new Error(`DSH session was not found: ${sessionId}`);
  }
  const updatedAtMs = typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
    ? item.updatedAt
    : 0;
  const title = typeof item.projections?.values?.title === "string" && item.projections.values.title.trim()
    ? item.projections.values.title.trim()
    : sessionId;
  const running = item.running === true;
  return {
    id: sessionId,
    title,
    cwd: typeof item.cwd === "string" && item.cwd.trim() ? item.cwd : undefined,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : new Date(0).toISOString(),
    archived: false,
    source: "DSH session (apiproxy)",
    active: running,
    status: { type: running ? "active" : "idle" }
  };
}

function imageContentPart(imagePath: string): { type: "image"; mediaType: string; data: string; name: string } {
  const stat = fs.statSync(imagePath, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`DSH delivery image does not exist: ${imagePath}`);
  if (stat.size > DSH_IMAGE_MAX_BYTES) {
    throw new Error(`DSH delivery image exceeds 5 MiB: ${imagePath}`);
  }
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".gif" ? "image/gif"
        : ext === ".webp" ? "image/webp"
          : ext === ".bmp" ? "image/bmp"
            : undefined;
  if (!mediaType) throw new Error(`Unsupported DSH delivery image type: ${imagePath}`);
  return {
    type: "image",
    mediaType,
    data: fs.readFileSync(imagePath).toString("base64"),
    name: path.basename(imagePath)
  };
}

export type DshSessionDelivery = {
  threadId: string;
  action: "started";
  openedThread: false;
  transport: "http";
  warning?: string;
};

/**
 * Deliver one prompt into a live DSH session through `session.prompt`
 * (mode=queue: the host appends a user message and the agent loop picks it up).
 *
 * Image handling: images are first attached as image content parts. When the
 * session's model rejects image input (e.g. DeepSeek V4 Flash is text-only),
 * the delivery degrades to a text part carrying the local image paths plus an
 * explicit instruction to inspect them with the `analyze_image` tool — the
 * DSH session runs on the same machine and can read those files.
 */
export async function sendDshSessionMessage(params: {
  sessionId: string;
  prompt: string;
  cwd: string;
  baseUrl?: string;
  imagePaths?: string[];
}): Promise<DshSessionDelivery> {
  const baseUrl = (params.baseUrl || DEFAULT_DSH_BASE_URL).replace(/\/+$/, "");
  const imagePaths = params.imagePaths || [];
  const content: Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string; name: string }> = [
    { type: "text", text: params.prompt }
  ];
  for (const imagePath of imagePaths) {
    content.push(imageContentPart(imagePath));
  }
  const result = await dshRpc<{ accepted?: boolean }>(baseUrl, "session.prompt", {
    sessionId: params.sessionId,
    mode: "queue",
    content
  });
  if (result.ok) {
    return {
      threadId: params.sessionId,
      action: "started",
      openedThread: false,
      transport: "http"
    };
  }
  const rejection = `${result.error.message || result.error.code || ""}`;
  if (imagePaths.length > 0 && /image input|image.*not support|not support.*image|image.*unsupported|unsupported.*image/i.test(rejection)) {
    const degraded = buildImagePathDegradedPrompt(params.prompt, imagePaths);
    const retried = await dshRpc<{ accepted?: boolean }>(baseUrl, "session.prompt", {
      sessionId: params.sessionId,
      mode: "queue",
      content: [{ type: "text", text: degraded }]
    });
    if (retried.ok) {
      return {
        threadId: params.sessionId,
        action: "started",
        openedThread: false,
        transport: "http",
        warning: `DSH 会话模型不支持图片输入，已降级为文本投递并附 ${imagePaths.length} 张图片的本地路径（可用 analyze_image 查看）。`
      };
    }
    throw new Error(
      `DSH session delivery rejected: ${retried.error.message || retried.error.code || "unknown error"}`
    );
  }
  throw new Error(`DSH session delivery rejected: ${rejection}`);
}

function buildImagePathDegradedPrompt(prompt: string, imagePaths: string[]): string {
  const lines = imagePaths.map((imagePath, index) => `${index + 1}. ${imagePath}`);
  return [
    prompt,
    "",
    `[图片附件（共 ${imagePaths.length} 张）]`,
    "本会话模型不支持图片输入，图片未随消息上传；图片位于本机，请按需使用 analyze_image 工具（或直接读取文件）查看后再判断。",
    ...lines
  ].join("\n");
}

/**
 * Deliver a plain message to the route's bound DSH primary session. Used by
 * the agent-adapter fallback path (`createAgentAdapter("dsh").deliver`).
 */
export async function notifyDshSession(message: string): Promise<{ sessionId: string }> {
  const binding = readDshPrimaryBinding();
  if (!binding) throw new Error("XinghaiBuilder route has no DSH primary binding.");
  await sendDshSessionMessage({
    sessionId: binding.sessionId,
    prompt: message,
    cwd: binding.cwd,
    baseUrl: binding.baseUrl
  });
  return { sessionId: binding.sessionId };
}
