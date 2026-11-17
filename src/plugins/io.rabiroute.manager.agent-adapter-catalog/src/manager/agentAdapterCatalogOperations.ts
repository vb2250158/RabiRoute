import type http from "node:http";
import type { AgentAdapterCatalogService } from "./agentAdapterCatalog.js";
import { AGENT_CATALOG_OPERATIONS, agentAdapterCatalogContract, agentCatalogScanOptions, type AgentCatalogOperationKey } from "@rabiroute/host-api/manager/agentAdapterCatalogContract";
import { AgentAdapterCatalogWorkerError } from "@rabiroute/host-api/manager/agentAdapterCatalogWorkerPool";

import type { ApiOperationDefinition, ApiOperationResult } from "@rabiroute/host-api/manager/apiOperationContract";

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
    if (connection) return { status: typeof (error as { status?: number })?.status === "number" ? (error as { status: number }).status : 500,
      body: { ok: false, message: error instanceof Error ? error.message : "DSH connection operation failed; refresh before retrying." } };
    const status = error instanceof AgentAdapterCatalogWorkerError && error.code === "busy" ? 503 : 500;
    return { status, body: { ...(key === "hooks" ? { ok: false } : { code: -1 }), message: error instanceof Error ? error.message : String(error) } };
  } finally { lifetime?.dispose(); }
}

const catalogPurposes: Record<string,string> = {catalog:'查询可用 Agent 适配器与支持能力',all:'扫描全部 Agent 的安装与会话状态',hooks:'安装或更新指定 Agent 的生命周期 Hook'};
export function createAgentAdapterCatalogOperations(service: AgentAdapterCatalogService): readonly ApiOperationDefinition[] {
  return AGENT_CATALOG_OPERATIONS.filter(definition => ["catalog", "all", "hooks"].includes(definition.key)).map(definition => ({ contract: agentAdapterCatalogContract(definition), discovery:{title:catalogPurposes[definition.key],summary:catalogPurposes[definition.key]+"。按实际适配器能力继续查询会话和保存路由绑定；单端扫描失败保留其它端结果。",category:{id:"agents",title:"Agent 协作"},keywords:[catalogPurposes[definition.key],definition.key,"agent adapters","Agent接入","Agent配置"],relatedOperations:["manager.agent.threads.action","manager.gateway-runtime.config.save"],...(definition.key==="hooks"?{inputSources:[{field:"query.adapter",operationId:"agent.adapters.catalog.get",resultPath:"/data/adapters",valuePath:"/type"}]}:{})}, handler: input =>
    runAgentAdapterCatalogOperation(definition.key, input.request, input.url, input.response, service,
      definition.key === "connect" || definition.key === "disconnect" ? { value: input.body, signal: input.signal } : undefined) }));
}
