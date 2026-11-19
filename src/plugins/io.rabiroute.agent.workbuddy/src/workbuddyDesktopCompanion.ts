import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createWorkbuddyDesktopCreator } from "./workbuddyDesktopCreation.js";
import { clearClosedWorkbuddyDesktopRelay, serveWorkbuddyDesktopRelay } from "./workbuddyDesktopRelay.js";
import { workbuddyDesktopContinuationReadinessExpression, workbuddyDesktopMessageExpression,
  type WorkbuddyDesktopContinuationReadiness, type WorkbuddyDesktopMessageResult } from "./workbuddyDesktopSteer.js";
import { workbuddyHomeDir } from "./workbuddySessionStore.js";

const execute = promisify(execFile);
type Reply = { id?: number; result?: unknown; error?: { message: string } };

export async function startWorkbuddyDesktopCompanion(windowObserver: string) {
  if (process.platform !== "win32") throw new Error("The WorkBuddy desktop connector requires Windows.");
  const executable = path.join(process.env.ProgramFiles || "C:\\Program Files", "WorkBuddy", "WorkBuddy.exe");
  const renderer = pathToFileURL(path.join(path.dirname(executable), "resources", "app.asar", "renderer", "index.html")).pathname.toLowerCase();
  const observeArgs = ["-NoProfile", "-NonInteractive", "-File", windowObserver, "-Executable", executable];
  await execute("powershell.exe", observeArgs, { windowsHide: true, timeout: 5000 });
  await clearClosedWorkbuddyDesktopRelay();
  const child = spawn(executable, ["--remote-debugging-pipe"], {
    detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: "" }
  });
  const writer = child.stdio[3];
  const reader = child.stdio[4];
  if (!(writer instanceof Writable) || !(reader instanceof Readable)) {
    child.kill();
    throw new Error("Could not establish the WorkBuddy inherited renderer pipe.");
  }
  const input: Writable = writer;
  const output: Readable = reader;
  let serial = 0;
  let buffer = "";
  let closed = false;
  const pending = new Map<number, (reply: Reply) => void>();
  const disconnect = () => {
    if (closed) return;
    closed = true;
    for (const reply of pending.values()) reply({ error: { message: "WorkBuddy renderer pipe closed." } });
    input.destroy();
    output.destroy();
  };
  child.on("error", disconnect);
  child.on("exit", disconnect);
  input.on("error", disconnect);
  output.on("error", disconnect);
  output.setEncoding("utf8");
  output.on("data", chunk => {
    buffer += chunk;
    const frames = buffer.split("\0");
    buffer = frames.pop()!;
    try {
      for (const frame of frames) {
        const reply = JSON.parse(frame) as Reply;
        if (reply.id !== undefined) pending.get(reply.id)?.(reply);
      }
    } catch { disconnect(); }
  });

  async function call<T>(method: string, params: object = {}, sessionId?: string, timeoutMs = 4000): Promise<T> {
    if (closed) throw new Error("WorkBuddy renderer pipe is unavailable.");
    const id = ++serial;
    const reply = await new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WorkBuddy renderer rejected or timed out: ${method}.`)), timeoutMs);
      pending.set(id, result => { clearTimeout(timer); resolve(result); });
      input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    }).finally(() => pending.delete(id));
    if (reply.error) throw new Error(reply.error.message);
    return reply.result as T;
  }

  const observe = async (minimize = false) => {
    const args = [...observeArgs, "-WorkBuddyPid", String(child.pid), ...(minimize ? ["-Minimize"] : [])];
    const { stdout } = await execute("powershell.exe", args, { windowsHide: true, timeout: 7000 });
    return JSON.parse(stdout) as { window: number; minimized: boolean; isForeground: boolean };
  };

  try {
    const deadline = performance.now() + 20_000;
    let targetId: string | undefined;
    while (!targetId && performance.now() < deadline) {
      const { targetInfos } = await call<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets");
      const matches = targetInfos.filter(target => target.type === "page" && target.url.startsWith("file:")
        && new URL(target.url).pathname.toLowerCase() === renderer);
      if (matches.length > 1) throw new Error("WorkBuddy exposes more than one main renderer.");
      targetId = matches[0]?.targetId;
      if (!targetId) await delay(300);
    }
    if (!targetId) throw new Error("WorkBuddy main renderer is unavailable.");
    const { sessionId } = await call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const run = async (expression: string, returnByValue: boolean, awaitPromise = false, timeoutMs = awaitPromise ? 20_000 : undefined) => {
      const reply = await call<{ exceptionDetails?: unknown; result: { value?: unknown; objectId?: string } }>(
        "Runtime.evaluate", { expression, returnByValue, awaitPromise }, sessionId, timeoutMs);
      if (reply.exceptionDetails) throw new Error("WorkBuddy renderer did not apply the desktop action.");
      return reply.result;
    };
    const minimized = await observe(true);
    if (!minimized.minimized || minimized.isForeground) throw new Error("WorkBuddy could not start minimized.");
    const create = createWorkbuddyDesktopCreator({
      evaluate: async <T>(expression: string) => (await run(expression, true)).value as T,
      focusComposer: async expression => {
        const { objectId } = await run(expression, false);
        if (!objectId) throw new Error("WorkBuddy new-task composer is not empty or unavailable.");
        await call("DOM.focus", { objectId }, sessionId);
      },
      enableRendererFocus: async () => { await call("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId); },
      disableRendererFocus: async () => { if (!closed) await call("Emulation.setFocusEmulationEnabled", { enabled: false }, sessionId); },
      insertText: async text => { await call("Input.insertText", { text }, sessionId); },
      observeWindow: () => observe(),
    }, path.join(workbuddyHomeDir(), "rabiroute-desktop-intents"));
    const stopRelay = await serveWorkbuddyDesktopRelay(create, undefined, async (input, signal, mode) => {
      signal.throwIfAborted();
      if (mode === "continue") {
        const expression = workbuddyDesktopContinuationReadinessExpression(input);
        const deadline = performance.now() + 6_000;
        let readiness: WorkbuddyDesktopContinuationReadiness = "loading";
        while (readiness === "loading" && performance.now() < deadline) {
          readiness = (await run(expression, true, true, Math.max(1, deadline - performance.now()))).value as WorkbuddyDesktopContinuationReadiness;
          signal.throwIfAborted();
          if (readiness === "loading") await delay(200, undefined, { signal });
        }
        if (readiness !== "ready") return { state: "unavailable", threadId: input.threadId, deliveryId: input.deliveryId };
      }
      signal.throwIfAborted();
      return (await run(workbuddyDesktopMessageExpression(input, mode), true, true)).value as WorkbuddyDesktopMessageResult;
    });
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= stopRelay().finally(disconnect);
    child.once("exit", () => { void stop().catch(() => undefined); });
    return { processId: child.pid, stop };
  } catch (error) {
    disconnect();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const observer = fileURLToPath(new URL("../assets/desktop-window.ps1", import.meta.url));
  void startWorkbuddyDesktopCompanion(observer).then(({ processId, stop }) => {
    console.log(JSON.stringify({ ready: true, processId }));
    process.once("SIGINT", () => { void stop(); });
    process.once("SIGTERM", () => { void stop(); });
  }).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
