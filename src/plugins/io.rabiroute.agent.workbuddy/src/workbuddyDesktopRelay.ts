import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { workbuddyHomeDir } from "./workbuddySessionStore.js";
import type { WorkbuddyDesktopCreationInput, WorkbuddyDesktopCreationResult } from "./workbuddyDesktopCreation.js";
import { isLegacyWorkbuddyDesktopLayout, isWorkbuddyDesktopLayout } from "./workbuddyDesktopLayout.js";
import type { WorkbuddyDesktopMessageMode, WorkbuddyDesktopMessageInput, WorkbuddyDesktopMessageResult } from "./workbuddyDesktopSteer.js";

const pipePrefix = "\\\\.\\pipe\\RabiRoute.WorkBuddy.Desktop.";
const frameLimit = 2 * 1024 * 1024;
const composerLayoutContract = 1;
const steerContract = 2;
const continuationContract = 2;
const descriptorPath = () => path.join(workbuddyHomeDir(), "rabiroute-desktop-relay.json");
type DesktopRelay = { pipe: string; token: string; composerLayoutContract?: number; steerContract?: number; continuationContract?: number };

export class WorkbuddyDesktopMessageNotSentError extends Error {}

function receiveFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > frameLimit) {
        socket.destroy();
        reject(new Error("WorkBuddy desktop relay frame exceeds the size limit."));
        return;
      }
      const end = buffered.indexOf("\n");
      if (end === -1) return;
      try { resolve(JSON.parse(buffered.slice(0, end))); } catch (error) { reject(error); }
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("WorkBuddy desktop relay connection closed.")));
  });
}

function creationInput(value: unknown): value is WorkbuddyDesktopCreationInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return ["intentId", "title", "workspace", "workspaceLabel", "prompt"].every(key =>
    typeof input[key] === "string" && (input[key] as string).trim().length > 0)
    && (input.layout === undefined || isWorkbuddyDesktopLayout(input.layout));
}

function authenticates(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function steerInput(value: unknown): value is WorkbuddyDesktopMessageInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return ["threadId", "workspace", "text", "deliveryId"].every(key =>
    typeof input[key] === "string" && (input[key] as string).trim().length > 0);
}

/** The foreground-independent desktop launcher owns this relay and the inherited renderer pipe. */
export async function serveWorkbuddyDesktopRelay(
  create: (input: WorkbuddyDesktopCreationInput, signal: AbortSignal) => Promise<WorkbuddyDesktopCreationResult>,
  descriptor = descriptorPath(),
  send?: (input: WorkbuddyDesktopMessageInput, signal: AbortSignal, mode: WorkbuddyDesktopMessageMode) => Promise<WorkbuddyDesktopMessageResult>
): Promise<() => Promise<void>> {
  const relay = { pipe: `${pipePrefix}${randomUUID()}`, token: randomBytes(32).toString("hex"), composerLayoutContract,
    ...(send && { steerContract, continuationContract }) };
  const server = createServer({ allowHalfOpen: false }, socket => {
    const controller = new AbortController();
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("close", () => controller.abort());
    void (async () => {
      try {
        const request = await receiveFrame(socket) as { token?: unknown; input?: unknown; action?: unknown };
        if (!authenticates(request?.token, relay.token)) throw new Error("Unauthorized WorkBuddy desktop request.");
        let result: WorkbuddyDesktopCreationResult | WorkbuddyDesktopMessageResult;
        if ((request.action === "steer" || request.action === "continue") && send && steerInput(request.input)) {
          result = await send(request.input, controller.signal, request.action);
        } else if (request.action === undefined && creationInput(request.input)) {
          result = await create(request.input, controller.signal);
        } else throw new Error("Invalid or unsupported WorkBuddy desktop request.");
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : "WorkBuddy desktop request failed." })}\n`);
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(relay.pipe, resolve);
  });
  try { await writeFile(descriptor, JSON.stringify(relay), { flag: "wx", mode: 0o600 }); }
  catch (error) { server.close(); throw error; }
  return async () => {
    try { await unlink(descriptor); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}

async function findRelay(descriptor: string): Promise<DesktopRelay | null> {
  const relay = await readFile(descriptor, "utf8").then(text => text ? JSON.parse(text) as DesktopRelay : null).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (relay === null) return null;
  if (typeof relay.pipe !== "string" || !relay.pipe.startsWith(pipePrefix) || !/^[a-f0-9-]{36}$/.test(relay.pipe.slice(pipePrefix.length))
    || typeof relay.token !== "string" || !/^[a-f0-9]{64}$/.test(relay.token)) throw new Error("WorkBuddy 桌面连接器配置无效。");
  return relay;
}

function probeRelay(relay: DesktopRelay): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(relay.pipe);
    socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error("WorkBuddy 桌面连接器尚未响应。")); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("close", () => resolve(false));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

/** A transport probe sends no message and works with older connected workers. */
export async function isWorkbuddyDesktopRelayReady(descriptor = descriptorPath()): Promise<boolean> {
  const relay = await findRelay(descriptor);
  return relay ? probeRelay(relay) : false;
}

/** Only the desktop launcher calls this, after proving that the original desktop is closed. */
export async function clearClosedWorkbuddyDesktopRelay(descriptor = descriptorPath()): Promise<void> {
  const stale = await findRelay(descriptor);
  if (!stale) return;
  if (await probeRelay(stale)) throw new Error("WorkBuddy 桌面连接器仍在运行。");
  const current = await findRelay(descriptor);
  if (!current) return;
  if (current.pipe !== stale.pipe || current.token !== stale.token) throw new Error("WorkBuddy 桌面连接器已切换。");
  await unlink(descriptor);
}

async function invokeRelay<Result>(relay: DesktopRelay, payload: { input: unknown; action?: string }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const socket = createConnection(relay.pipe);
  const cancel = () => socket.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  socket.setTimeout(30_000, cancel);
  try {
    const response = receiveFrame(socket);
    socket.write(`${JSON.stringify({ token: relay.token, ...payload })}\n`);
    const reply = await response as { ok?: boolean; result?: Result; message?: string };
    if (reply?.ok !== true || !reply.result) throw new Error(reply?.message || "WorkBuddy 桌面操作未返回回执。");
    return reply.result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    socket.destroy();
  }
}

export async function requestWorkbuddyDesktopCreation(
  input: WorkbuddyDesktopCreationInput,
  signal?: AbortSignal,
  descriptor = descriptorPath()
): Promise<WorkbuddyDesktopCreationResult> {
  signal?.throwIfAborted();
  const relay = await findRelay(descriptor);
  if (!relay) throw new Error("WorkBuddy 桌面创建尚未连接，请先启动桌面连接器。");
  const { layout, ...baseInput } = input;
  if (layout !== undefined && !isWorkbuddyDesktopLayout(layout)) throw new Error("WorkBuddy 桌面布局无效。");
  const canSelectLayout = relay.composerLayoutContract === composerLayoutContract;
  if (layout && !canSelectLayout && !isLegacyWorkbuddyDesktopLayout(layout)) {
    throw new Error("当前 WorkBuddy 桌面连接器不支持所选布局，请更新桌面连接器后再提交。");
  }
  const result = await invokeRelay<WorkbuddyDesktopCreationResult>(relay, { input: canSelectLayout ? input : baseInput }, signal);
  if (result.intentId !== input.intentId) throw new Error("WorkBuddy 桌面创建回执与原编号不匹配。");
  return result;
}

export async function requestWorkbuddyDesktopSteer(
  input: WorkbuddyDesktopMessageInput,
  assertAuthorized?: () => void | Promise<void>,
  descriptor = descriptorPath()
): Promise<void> {
  return requestWorkbuddyDesktopMessage(input, "steer", assertAuthorized, descriptor);
}

export async function requestWorkbuddyDesktopMessage(
  input: WorkbuddyDesktopMessageInput,
  mode: WorkbuddyDesktopMessageMode,
  assertAuthorized?: () => void | Promise<void>,
  descriptor = descriptorPath()
): Promise<void> {
  const relay = await findRelay(descriptor).catch(error => {
    throw new WorkbuddyDesktopMessageNotSentError(error instanceof Error ? error.message : String(error));
  });
  if (!relay) throw new WorkbuddyDesktopMessageNotSentError("WorkBuddy 桌面连接器尚未连接，请先启动桌面连接器。");
  if (mode === "steer" ? relay.steerContract !== steerContract : relay.continuationContract !== continuationContract) {
    const name = mode === "steer" ? "引导会话" : "后台唤起原会话";
    throw new WorkbuddyDesktopMessageNotSentError(`当前 WorkBuddy 桌面连接器不支持本版${name}，请更新连接器。`);
  }
  await assertAuthorized?.();
  const result = await invokeRelay<WorkbuddyDesktopMessageResult>(relay, { action: mode, input });
  if (result.threadId !== input.threadId || result.deliveryId !== input.deliveryId) {
    throw new Error("WorkBuddy 桌面投递未返回匹配的接收回执。");
  }
  if (result.state === "inactive") throw new WorkbuddyDesktopMessageNotSentError("WorkBuddy 目标会话当前没有可引导的执行轮次。");
  if (result.state === "unavailable") throw new WorkbuddyDesktopMessageNotSentError("WorkBuddy 桌面端未确认目标会话或工作区。");
  if (result.state !== "accepted") throw new Error("WorkBuddy 桌面投递结果待确认，请查询原投递编号和目标会话历史。");
}
