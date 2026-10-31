import type http from "node:http";
import type { AgentAdapterCatalogService } from "./agentAdapterCatalog.js";
import { AGENT_CATALOG_OPERATIONS, agentAdapterCatalogContract, agentCatalogScanOptions, type AgentCatalogOperationKey } from "./agentAdapterCatalogContract.js";
import { AgentAdapterCatalogWorkerError } from "./agentAdapterCatalogWorkerPool.js";
import { DshConnectionError } from "../dshConnectionStore.js";
import type { ApiOperationDefinition, ApiOperationResult } from "./apiOperationContract.js";

export function catalogResponseAbortSignal(request: http.IncomingMessage, response: http.ServerResponse): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  // A real close usually sets destroyed=true first. That must still cancel the read.
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  request.once("aborted", abort); response.once("close", abort);
  return { signal: controller.signal, dispose() { request.off("aborted", abort); response.off("close", abort); } };
}

export async function runAgentAdapterCatalogOperation(key: AgentCatalogOperationKey, request: http.IncomingMessage, url: URL,
  response: http.ServerResponse, service: AgentAdapterCatalogService, parsedBody?: Readonly<{ value: unknown; signal?: AbortSignal }>): Promise<ApiOperationResult> {
  const connection = ["connection", "connections", "connect", "disconnect"].includes(key);
  let lifetime: ReturnType<typeof catalogResponseAbortSignal> | undefined;
  try {
    if (connection) return { status: 200, body: await service.connectionOperation(request, url, parsedBody) };
    if (key === "hooks") return { status: 200, body: { ok: true, ...await service.updateHooks(url.searchParams.get("adapter") || "") } };
    if (key === "catalog") return { status: 200, body: { code: 0, data: await service.catalog() } };
    lifetime = catalogResponseAbortSignal(request, response);
    const options = agentCatalogScanOptions(key as "all" | "dsh" | "grokBot", url);
    const data = key === "dsh" ? await service.scanDsh(options, lifetime.signal) : key === "grokBot"
      ? await service.scanGrokBot(options, lifetime.signal) : await service.scanAll(options, lifetime.signal);
    return { status: 200, body: data };
  } catch (error) {
    if (connection) return { status: error instanceof DshConnectionError ? error.status : 500,
      body: { ok: false, message: error instanceof DshConnectionError ? error.message : "DSH connection operation failed; refresh before retrying." } };
    const status = error instanceof AgentAdapterCatalogWorkerError && error.code === "busy" ? 503 : 500;
    return { status, body: { ...(key === "hooks" ? { ok: false } : { code: -1 }), message: error instanceof Error ? error.message : String(error) } };
  } finally { lifetime?.dispose(); }
}

export function createAgentAdapterCatalogOperations(service: AgentAdapterCatalogService): readonly ApiOperationDefinition[] {
  return AGENT_CATALOG_OPERATIONS.map(definition => ({ contract: agentAdapterCatalogContract(definition), handler: input =>
    runAgentAdapterCatalogOperation(definition.key, input.request, input.url, input.response, service,
      definition.key === "connect" || definition.key === "disconnect" ? { value: input.body, signal: input.signal } : undefined) }));
}
