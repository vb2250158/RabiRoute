import { configureTimeouts } from "../shared/timeoutSettings.js";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { AgentScanOptions, AgentScanRuntimeSnapshot } from "../agentAdapters/managerTypes.js";
import type { AgentAdapterDescriptor } from "@rabiroute/plugin-sdk";

export type AgentAdapterCatalogWorkerTask = {
  kind: "provider";
  /** Supplied by the published owner, never an HTTP query field. */
  entry: string;
  exportName?: string;
  rootDir: string;
  runtimes: AgentScanRuntimeSnapshot[];
  options: AgentScanOptions;
  manifest?: AgentAdapterDescriptor;
  cwdOptions?: string[];
  runtimeLayout?: Readonly<{ packageRoot: string; stateRoot: string }>;
};
export type AgentAdapterCatalogWorkerRequest = { timeoutOverrides?: Record<string, number>; requestId: string; task: AgentAdapterCatalogWorkerTask };
export type AgentAdapterCatalogWorkerResponse = (
  { ok: true; value: unknown } | { ok: false; message: string; stack?: string }
) & { requestId: string };

export async function executeAgentAdapterCatalogWorkerTask(task: AgentAdapterCatalogWorkerTask): Promise<unknown> {
  if (!task.entry || !path.isAbsolute(task.entry)) throw new Error("An active Agent package must supply its owned scanner entry.");
  const implementation = await import(pathToFileURL(task.entry).href) as Record<string, unknown>;
  const scan = implementation[task.exportName ?? "scan"];
  if (typeof scan !== "function") throw new Error("The Agent package scanner export is unavailable.");
  return scan({ rootDir: task.rootDir, runtimes: task.runtimes, manifest: task.manifest, cwdOptions: task.cwdOptions }, task.options);
}

let workerLayout: string | undefined;
async function respond(request: AgentAdapterCatalogWorkerRequest): Promise<void> {
  try {
    const layout = request.task.runtimeLayout;
    if (layout) {
      if (!path.isAbsolute(layout.packageRoot) || !path.isAbsolute(layout.stateRoot)) throw new Error("Worker runtime layout must use absolute roots.");
      const identity = JSON.stringify(layout);
      if (workerLayout && workerLayout !== identity) throw new Error("Worker belongs to another application runtime layout.");
      workerLayout = identity;
      // Only the dedicated child process receives these roots, before importing platform code.
      process.env.RABIROUTE_PACKAGE_ROOT = layout.packageRoot;
      process.env.RABIROUTE_STATE_ROOT = layout.stateRoot;
    }
    configureTimeouts(request.timeoutOverrides ?? {});
    process.send?.({ requestId: request.requestId, ok: true, value: await executeAgentAdapterCatalogWorkerTask(request.task) } satisfies AgentAdapterCatalogWorkerResponse);
  } catch (error) {
    process.send?.({ requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : "Agent scanner failed.", stack: error instanceof Error ? error.stack : undefined } satisfies AgentAdapterCatalogWorkerResponse);
  }
}

if (process.send) {
  process.on("message", request => { void respond(request as AgentAdapterCatalogWorkerRequest); });
  process.once("disconnect", () => process.exit(0));
}
