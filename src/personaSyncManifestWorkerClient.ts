import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  PersonaSyncManifestRefreshRequest,
  PersonaSyncManifestRefreshResponse,
  PersonaSyncManifestRefreshResult
} from "./personaSyncManifestWorkerProtocol.js";

const WORKER_STOP_DEADLINE_MS = 2_000;

export class PersonaSyncManifestWorkerError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "aborted" | "worker_failed" | "termination_failed"
  ) {
    super(message);
    this.name = "PersonaSyncManifestWorkerError";
  }
}

export type PersonaSyncManifestWorkerRunOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  testDelayMs?: number;
  onSpawn?(pid: number): void;
};

function workerEntryPath(): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./personaSyncManifestWorker.ts" : "./personaSyncManifestWorker.js",
    import.meta.url
  ));
}

function workerExecArgv(): string[] {
  return import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [];
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC",
    "TEMP", "TMP", "TMPDIR", "NODE_PATH"
  ] as const;
  const environment: NodeJS.ProcessEnv = {
    RABIROUTE_PERSONA_MANIFEST_WORKER: "1"
  };
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = new Promise<void>(resolve => {
    worker.once("exit", () => resolve());
    worker.once("close", () => resolve());
  });
  if (worker.connected) worker.disconnect();
  worker.kill();
  await Promise.race([
    exited,
    new Promise<void>(resolve => setTimeout(resolve, WORKER_STOP_DEADLINE_MS))
  ]);
  if (worker.exitCode === null && worker.signalCode === null) {
    worker.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise<void>(resolve => setTimeout(resolve, WORKER_STOP_DEADLINE_MS))
    ]);
  }
  if (worker.exitCode === null && worker.signalCode === null) {
    throw new PersonaSyncManifestWorkerError(
      `Persona manifest worker ${worker.pid ?? "unknown"} did not confirm exit after SIGKILL.`,
      "termination_failed"
    );
  }
}

export function runPersonaSyncManifestWorker(
  rolesRoot: string,
  stateRoot: string,
  options: PersonaSyncManifestWorkerRunOptions
): Promise<PersonaSyncManifestRefreshResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new PersonaSyncManifestWorkerError("Persona manifest refresh was aborted.", "aborted"));
  }
  const request: PersonaSyncManifestRefreshRequest = {
    requestId: randomUUID(),
    rolesRoot,
    stateRoot,
    testDelayMs: options.testDelayMs
  };
  return new Promise<PersonaSyncManifestRefreshResult>((resolve, reject) => {
    let worker: ChildProcess;
    try {
      worker = fork(workerEntryPath(), [], {
        cwd: process.cwd(),
        execArgv: workerExecArgv(),
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: workerEnvironment()
      });
    } catch (error) {
      reject(new PersonaSyncManifestWorkerError(
        error instanceof Error ? error.message : String(error),
        "worker_failed"
      ));
      return;
    }
    const pid = worker.pid;
    if (!pid) {
      void stopWorker(worker).then(
        () => reject(new PersonaSyncManifestWorkerError("Persona manifest worker did not publish a process id.", "worker_failed")),
        reject
      );
      return;
    }
    options.onSpawn?.(pid);
    worker.unref();
    worker.channel?.unref?.();
    let settled = false;
    const timeoutMs = Math.max(100, Math.floor(options.timeoutMs));
    const finish = async (
      error?: PersonaSyncManifestWorkerError,
      value?: PersonaSyncManifestRefreshResult
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
      try {
        await stopWorker(worker);
      } catch (stopError) {
        reject(stopError);
        return;
      }
      if (error) reject(error);
      else resolve(value as PersonaSyncManifestRefreshResult);
    };
    const timer = setTimeout(() => {
      void finish(new PersonaSyncManifestWorkerError(
        `Persona manifest refresh exceeded ${timeoutMs} ms.`,
        "timeout"
      ));
    }, timeoutMs);
    timer.unref?.();
    const abortListener = options.signal
      ? () => void finish(new PersonaSyncManifestWorkerError("Persona manifest refresh was aborted.", "aborted"))
      : undefined;
    if (abortListener) options.signal!.addEventListener("abort", abortListener, { once: true });
    worker.on("message", raw => {
      const message = raw as PersonaSyncManifestRefreshResponse;
      if (!message || message.requestId !== request.requestId) return;
      if (message.ok) void finish(undefined, message.value);
      else void finish(new PersonaSyncManifestWorkerError(message.message, "worker_failed"));
    });
    worker.once("error", error => {
      void finish(new PersonaSyncManifestWorkerError(error.message, "worker_failed"));
    });
    worker.once("exit", code => {
      if (settled) return;
      void finish(new PersonaSyncManifestWorkerError(
        `Persona manifest worker exited before publishing a snapshot (code ${code}).`,
        "worker_failed"
      ));
    });
    try {
      worker.send(request, error => {
        if (error) void finish(new PersonaSyncManifestWorkerError(error.message, "worker_failed"));
      });
    } catch (error) {
      void finish(new PersonaSyncManifestWorkerError(
        error instanceof Error ? error.message : String(error),
        "worker_failed"
      ));
    }
  });
}
