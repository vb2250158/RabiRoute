import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StorageAttempt } from "./boundedStorageStartup.js";
import type { RouteCatalogTransactionInput } from "./routeCatalogTransaction.js";

export type StorageStartupTask =
  | Readonly<{ kind: "directories"; root: string; catalog?: "routes" }>
  | Readonly<{ kind: "plan"; rolesRoot: string; roleId: string }>
  | Readonly<{ kind: "catalog_recovery"; input: RouteCatalogTransactionInput }>
  | Readonly<{ kind: "route"; input: RouteCatalogTransactionInput; configName: string }>
  | Readonly<{ kind: "persona"; rolesRoot: string; roleId: string; roleFiles: string[] }>;

export function createStorageStartupProcess<Value>(
  task: StorageStartupTask,
  terminateTimeoutMs = 5_000
): StorageAttempt<Value> {
  const child = fork(fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "./storageStartupChild.ts" : "./storageStartupChild.js",
    import.meta.url
  )), [], {
    env: {
      ...process.env,
      RABIROUTE_STORAGE_STARTUP_TASK: Buffer.from(JSON.stringify(task)).toString("base64url")
    },
    execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json"
  });
  let diagnosticBytes = 0;
  let message: { ok: boolean; value?: Value } | undefined;
  const capture = (chunk: Buffer): void => { diagnosticBytes += chunk.byteLength; };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("message", value => { message = value as typeof message; });
  let closed = false;
  let spawnFailed = false;
  child.on("error", () => { spawnFailed = true; });
  let notifyClose!: () => void;
  const closure = new Promise<void>(resolve => { notifyClose = resolve; });
  const result = new Promise<Value>((resolve, reject) => {
    child.once("close", code => {
      closed = true;
      notifyClose();
      if (!spawnFailed && code === 0 && message?.ok) resolve(message.value as Value);
      else reject(new Error(`Storage startup item failed; diagnosticBytes=${diagnosticBytes}.`));
    });
  });
  const wait = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([closure, new Promise<void>(resolve => { timer = setTimeout(resolve, terminateTimeoutMs); })]);
      return closed;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let cancellation: Promise<void> | undefined;
  return {
    result,
    cancel() {
      if (closed) return Promise.resolve();
      cancellation ??= (async () => {
        if (closed) return;
        child.kill();
        if (await wait()) return;
        child.kill("SIGKILL");
        if (!await wait()) throw new Error("Storage startup child exit is unconfirmed.");
      })();
      return cancellation;
    }
  };
}
