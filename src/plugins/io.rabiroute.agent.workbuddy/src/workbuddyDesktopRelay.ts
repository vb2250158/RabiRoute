import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { workbuddyHomeDir } from "./workbuddySessionStore.js";
import type { WorkbuddyDesktopCreationInput, WorkbuddyDesktopCreationResult } from "./workbuddyDesktopCreation.js";

const pipePrefix = "\\\\.\\pipe\\RabiRoute.WorkBuddy.Desktop.";
const frameLimit = 2 * 1024 * 1024;
const descriptorPath = () => path.join(workbuddyHomeDir(), "rabiroute-desktop-relay.json");
type DesktopRelay = { pipe: string; token: string };

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
    typeof input[key] === "string" && (input[key] as string).trim().length > 0);
}

function authenticates(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

/** The foreground-independent desktop launcher owns this relay and the inherited renderer pipe. */
export async function serveWorkbuddyDesktopRelay(
  create: (input: WorkbuddyDesktopCreationInput, signal: AbortSignal) => Promise<WorkbuddyDesktopCreationResult>,
  descriptor = descriptorPath()
): Promise<() => Promise<void>> {
  const relay = { pipe: `${pipePrefix}${randomUUID()}`, token: randomBytes(32).toString("hex") };
  const server = createServer({ allowHalfOpen: false }, socket => {
    const controller = new AbortController();
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("close", () => controller.abort());
    void (async () => {
      try {
        const request = await receiveFrame(socket) as { token?: unknown; input?: unknown };
        if (!authenticates(request?.token, relay.token) || !creationInput(request?.input)) {
          socket.end(`${JSON.stringify({ ok: false, message: "Unauthorized or invalid WorkBuddy desktop request." })}\n`);
          return;
        }
        const result = await create(request.input, controller.signal);
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

export async function requestWorkbuddyDesktopCreation(
  input: WorkbuddyDesktopCreationInput,
  signal?: AbortSignal,
  descriptor = descriptorPath()
): Promise<WorkbuddyDesktopCreationResult> {
  signal?.throwIfAborted();
  const relay = await readFile(descriptor, "utf8").then(text => JSON.parse(text) as DesktopRelay).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("WorkBuddy 桌面创建尚未连接，请先启动桌面连接器。");
    throw error;
  });
  if (!relay?.pipe?.startsWith(pipePrefix) || !/^[a-f0-9-]{36}$/.test(relay.pipe.slice(pipePrefix.length))
    || !/^[a-f0-9]{64}$/.test(relay.token)) throw new Error("WorkBuddy 桌面连接器配置无效。");
  const socket = createConnection(relay.pipe);
  const cancel = () => socket.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  socket.setTimeout(30_000, cancel);
  try {
    const response = receiveFrame(socket);
    socket.write(`${JSON.stringify({ token: relay.token, input })}\n`);
    const reply = await response as { ok?: boolean; result?: WorkbuddyDesktopCreationResult; message?: string };
    if (reply.ok !== true || !reply.result || reply.result.intentId !== input.intentId) {
      throw new Error(reply.message || "WorkBuddy 桌面创建回执与原编号不匹配。");
    }
    return reply.result;
  } finally {
    signal?.removeEventListener("abort", cancel);
    socket.destroy();
  }
}
