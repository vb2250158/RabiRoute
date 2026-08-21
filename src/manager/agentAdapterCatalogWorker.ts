import {
  scanAgentAdapters,
  scanDshAgentAdapter,
  type AgentScanOptions,
  type AgentScanRuntimeSnapshot
} from "../agentAdapters/managerApi.js";

export type AgentAdapterCatalogWorkerTask =
  | {
      kind: "all";
      rootDir: string;
      runtimes: AgentScanRuntimeSnapshot[];
      options: AgentScanOptions;
    }
  | {
      kind: "dsh";
      rootDir: string;
      runtimes: AgentScanRuntimeSnapshot[];
      options: Pick<AgentScanOptions, "dshLimit" | "dshOffset" | "dshQuery" | "dshBaseUrl">;
    };

export type AgentAdapterCatalogWorkerRequest = {
  requestId: string;
  task: AgentAdapterCatalogWorkerTask;
};

export type AgentAdapterCatalogWorkerResponse = (
  | { ok: true; value: unknown }
  | { ok: false; message: string; stack?: string }
) & {
  requestId: string;
};

export async function executeAgentAdapterCatalogWorkerTask(
  task: AgentAdapterCatalogWorkerTask
): Promise<unknown> {
  const context = { rootDir: task.rootDir, runtimes: task.runtimes };
  return task.kind === "dsh"
    ? scanDshAgentAdapter(context, task.options)
    : scanAgentAdapters(context, task.options);
}

function send(message: AgentAdapterCatalogWorkerResponse): void {
  if (!process.send) {
    throw new Error("Agent adapter catalog worker requires an IPC channel.");
  }
  process.send(message);
}

async function respond(request: AgentAdapterCatalogWorkerRequest): Promise<void> {
  try {
    send({
      requestId: request.requestId,
      ok: true,
      value: await executeAgentAdapterCatalogWorkerTask(request.task)
    });
  } catch (error) {
    send({
      requestId: request.requestId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  }
}

if (process.send) {
  process.on("message", request => {
    void respond(request as AgentAdapterCatalogWorkerRequest);
  });
  process.once("disconnect", () => process.exit(0));
}
