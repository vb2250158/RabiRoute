import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { workbuddyHomeDir } from "./workbuddySessionStore.js";
import type { WorkbuddyDesktopCreationInput, WorkbuddyDesktopCreationResult } from "./workbuddyDesktopCreation.js";
import { isLegacyWorkbuddyDesktopLayout, isWorkbuddyDesktopLayout } from "./workbuddyDesktopLayout.js";
import type { WorkbuddyDesktopSteerInput, WorkbuddyDesktopSteerResult } from "./workbuddyDesktopSteer.js";

const pipePrefix = "\\\\.\\pipe\\RabiRoute.WorkBuddy.Desktop.";
const frameLimit = 2 * 1024 * 1024;
const composerLayoutContract = 1;
const steerContract = 2;
const descriptorPath = () => path.join(workbuddyHomeDir(), "rabiroute-desktop-relay.json");
type DesktopRelay = { pipe: string; token: string; composerLayoutContract?: number; steerContract?: number };

export class WorkbuddyDesktopSteerNotSentError extends Error {}

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

function steerInput(value: unknown): value is WorkbuddyDesktopSteerInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return ["threadId", "workspace", "text", "deliveryId"].every(key =>
    typeof input[key] === "string" && (input[key] as string).trim().length > 0);
}

/** The foreground-independent desktop launcher owns this relay and the inherited renderer pipe. */
export async function serveWorkbuddyDesktopRelay(
  create: (input: WorkbuddyDesktopCreationInput, signal: AbortSignal) => Promise<WorkbuddyDesktopCreationResult>,
  descriptor = descriptorPath(),
  steer?: (input: WorkbuddyDesktopSteerInput, signal: AbortSignal) => Promise<WorkbuddyDesktopSteerResult>
): Promise<() => Promise<void>> {
  const relay = { pipe: `${pipePrefix}${randomUUID()}`, token: randomBytes(32).toString("hex"), composerLayoutContract, ...(steer && { steerContract }) };
  const server = createServer({ allowHalfOpen: false }, socket => {
    const controller = new AbortController();
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("close", () => controller.abort());
    void (async () => {
      try {
        const request = await receiveFrame(socket) as { token?: unknown; input?: unknown; action?: unknown };
        if (!authenticates(request?.token, relay.token)) throw new Error("Unauthorized WorkBuddy desktop request.");
        let result: WorkbuddyDesktopCreationResult | WorkbuddyDesktopSteerResult;
        if (request.action === "steer" && steer && steerInput(request.input)) {
          result = await steer(request.input, controller.signal);
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

async function readRelay(descriptor: string, notConnected: string): Promise<DesktopRelay> {
  const relay = await readFile(descriptor, "utf8").then(text => JSON.parse(text) as DesktopRelay).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(notConnected);
    throw error;
  });
  if (!relay?.pipe?.startsWith(pipePrefix) || !/^[a-f0-9-]{36}$/.test(relay.pipe.slice(pipePrefix.length))
    || !/^[a-f0-9]{64}$/.test(relay.token)) throw new Error("WorkBuddy 桌面连接器配置无效。");
  return relay;
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
  const relay = await readRelay(descriptor, "WorkBuddy 桌面创建尚未连接，请先启动桌面连接器。");
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
  input: WorkbuddyDesktopSteerInput,
  assertAuthorized?: () => void | Promise<void>,
  descriptor = descriptorPath()
): Promise<void> {
  const relay = await readRelay(descriptor, "WorkBuddy 桌面连接器尚未连接，请先启动桌面连接器。").catch(error => {
    throw new WorkbuddyDesktopSteerNotSentError(error instanceof Error ? error.message : String(error));
  });
  if (relay.steerContract !== steerContract) throw new WorkbuddyDesktopSteerNotSentError("当前 WorkBuddy 桌面连接器不支持本版引导会话，请更新连接器。");
  await assertAuthorized?.();
  const result = await invokeRelay<WorkbuddyDesktopSteerResult>(relay, { action: "steer", input });
  if (result.threadId !== input.threadId || result.deliveryId !== input.deliveryId) {
    throw new Error("WorkBuddy 引导请求未返回匹配的接收回执。");
  }
  if (result.state === "inactive") throw new WorkbuddyDesktopSteerNotSentError("WorkBuddy 目标会话当前没有可引导的执行轮次。");
  if (result.state === "unavailable") throw new WorkbuddyDesktopSteerNotSentError("WorkBuddy 桌面端未确认目标会话或工作区。");
  if (result.state !== "accepted") throw new Error("WorkBuddy 引导结果待确认，请查询原投递编号和目标会话历史。");
}
