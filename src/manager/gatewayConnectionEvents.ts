import fs from "node:fs";
import path from "node:path";

const statusName = "gateway-status.json";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Keep message counters, timestamps, and credentials out of the connection comparison. */
function connectionSignature(status: Record<string, unknown>): string {
  const instances = status.napcatInstances;
  const rows = instances && typeof instances === "object" ? Object.entries(instances) : [["default", status.napcat]];
  const napcat = rows.map(([id, value]) => {
    const row = record(value);
    return [row.id ?? row.instanceId ?? id, row.gatewayPort ?? row.port ?? row.wsPort, row.botUserId, row.connected, row.online];
  });
  const adapters = record(status.messageAdapters);
  const connections = ["qqbot", "weixin", "wecom", "feishu"].map(type => {
    const entry = record(adapters[type] ?? status[type]);
    return [entry.accountId, entry.status, entry.connected, entry.authenticated, entry.loggedIn, entry.credentialsRetained, entry.sessionPhase];
  });
  return JSON.stringify([napcat, connections]);
}

/** Watches the directory so both in-place writes and atomic file replacements are observed. */
export function watchGatewayConnection(directory: string, options: {
  load(file: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  changed(signal: AbortSignal): Promise<void>;
  onError(error: unknown): void;
}): () => void {
  const controller = new AbortController();
  const signal = controller.signal;
  const statusFile = path.join(directory, statusName);
  let watcher: fs.FSWatcher | undefined;
  let pending = false;
  let reading = false;
  let published: string | undefined;

  async function refresh(): Promise<void> {
    pending = true;
    if (reading) return;
    reading = true;
    try {
      while (pending && !signal.aborted) {
        pending = false;
        try {
          const next = connectionSignature(await options.load(statusFile, signal));
          if (signal.aborted || next === published) continue;
          await options.changed(signal);
          published = next;
        } catch (error) {
          if (!signal.aborted) options.onError(error);
        }
      }
    } finally { reading = false; }
  }

  function stop(): void {
    controller.abort();
    watcher?.close();
    watcher = undefined;
  }

  try {
    watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
      if (filename == null || filename === statusName) void refresh();
    });
    watcher.on("error", error => {
      stop();
      options.onError(error);
    });
  } catch (error) { options.onError(error); }
  void refresh();
  return stop;
}
