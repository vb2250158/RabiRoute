import { getTimeoutMs, readTimeoutOverrides } from "../shared/timeoutSettings.js";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { Readable } from "node:stream";

export const LOCAL_AGENT_MESSAGE_TIMEOUT_MS = 45_000;
export type LocalAgentMessageProcessOptions = {
  command: string; args: readonly string[]; shell?: boolean | string;
  cwd: string; env: NodeJS.ProcessEnv; text: string; messageId: string; label: string;
  onLog(line: string): void | Promise<void>;
  timeoutMs?: number; killGraceMs?: number;
  spawnProcess?(command: string, args: readonly string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
};

/** Own the accepted child, its IO callbacks and log acknowledgements through actual close. */
export function runLocalAgentMessageProcess(options: LocalAgentMessageProcessOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = (options.spawnProcess ?? spawn)(options.command, options.args, { cwd: options.cwd, env: { ...options.env, RABIROUTE_TIMEOUT_OVERRIDES: JSON.stringify(readTimeoutOverrides()) }, shell: options.shell, windowsHide: true }); }
    catch (error) { reject(error); return; }
    let failure: unknown, failed = false, closed = false, stopping = false;
    let deadline: ReturnType<typeof setTimeout> | undefined, escalation: ReturnType<typeof setTimeout> | undefined;
    const logs = new Set<Promise<void>>();
    const stop = (error: unknown) => {
      if (!failed) { failed = true; failure = error; }
      if (closed || stopping || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      stopping = true;
      try { child.kill(); } catch { /* The same child remains owned until close. */ }
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* Keep waiting for the owned handle. */ } }
      }, options.killGraceMs ?? getTimeoutMs("agent.localMessageKillGrace", 2000));
    };
    const logChunk = (stream: Readable, prefix: string, data: Buffer) => {
      stream.pause();
      let task: Promise<void>;
      task = Promise.resolve().then(async () => {
        for (const line of data.toString("utf8").split(/\r?\n/).filter(Boolean)) await options.onLog(prefix + line);
      }).catch(stop).then(() => { try { if (!stream.destroyed) stream.resume(); } catch (error) { stop(error); } logs.delete(task); });
      logs.add(task);
    };
    const stdout = (data: Buffer) => logChunk(child.stdout, `${options.label}: `, data);
    const stderr = (data: Buffer) => logChunk(child.stderr, `${options.label} error: `, data);
    const exited = () => { if (deadline) clearTimeout(deadline); if (escalation) clearTimeout(escalation); };
    child.stdout.on("data", stdout); child.stderr.on("data", stderr);
    child.on("error", stop); child.stdin.on("error", stop); child.once("exit", exited);
    child.once("close", (code, signal) => {
      closed = true; exited();
      child.stdout.off("data", stdout); child.stderr.off("data", stderr); child.off("error", stop); child.stdin.off("error", stop); child.off("exit", exited);
      void (async () => {
        const results = await Promise.allSettled([...logs]);
        for (const result of results) if (result.status === "rejected" && !failed) { failed = true; failure = result.reason; }
        if (failed) throw failure;
        if (code !== 0) throw new Error(`${options.label} failed: code=${code ?? "null"} signal=${signal ?? "null"}`);
        await options.onLog(`${options.label} completed: ${options.messageId}`);
      })().then(resolve, reject);
    });
    deadline = setTimeout(() => stop(new Error(`${options.label} timed out: ${options.messageId}`)), options.timeoutMs ?? getTimeoutMs("agent.localMessage", LOCAL_AGENT_MESSAGE_TIMEOUT_MS));
    try { child.stdin.end(options.text, "utf8"); } catch (error) { stop(error); }
  });
}
