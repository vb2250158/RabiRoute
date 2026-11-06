import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {getTimeoutMs} from '@rabiroute/host-api/shared/timeoutSettings';
import type {AgentManagerApiContext,AgentScanOptions,AgentScanResult,AgentScanSession,AgentSessionPage,AgentSessionPageQuery,AgentScanProject,AgentScanPerformanceOperation,CopilotSessionEntry,AstrbotSessionScan,AstrbotLoginTestRequest,MarvisOpenRequest} from '@rabiroute/host-api/agentAdapters/managerTypes';
import {agentScanManifestFields,getRuntimeList,projectOptionsFromPaths,normalizeComparablePath,checkHttpEndpoint,collectAgentCwdOptions} from '@rabiroute/host-api/agentAdapters/managerScanShared';
import {createCodexRuntime} from '../codexRuntime.js';import type {CodexModelCatalogEntry} from '@rabiroute/host-api/agentAdapters/codexContracts';import {PERFORMANCE_OPERATIONS} from '@rabiroute/host-api/shared/performanceOperations';import type {AgentAdapterDescriptor} from '@rabiroute/plugin-sdk';
export async function detectCodexBins(rootDir: string): Promise<string[]> {
  const localRuntime = path.join(rootDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  return fs.existsSync(localRuntime) ? [localRuntime] : [];
}
export function buildCodexAgentScan(input: {
  manifest?: AgentAdapterDescriptor;
  codexBins: string[];
  projects: AgentScanProject[];
  sessions: AgentScanSession[];
  sessionPage?: AgentSessionPage;
  desktopReady?: boolean;
  models?: CodexModelCatalogEntry[];
  sessionWarning?: string;
}): AgentScanResult {
  const codexBins = [...new Set(input.codexBins.filter(Boolean))];
  return {
    ...agentScanManifestFields("codex", input.manifest),
    installed: input.desktopReady === true || codexBins.length > 0,
    installCandidates: codexBins.map((binPath) => ({
      label: binPath.endsWith("codex.js") ? "@openai/codex" : path.basename(binPath),
      path: binPath
    })),
    projects: input.projects,
    // Desktop state supplies task identity; delivery is accepted only by the
    // Desktop owner for the exact opaque task id.
    sessions: input.sessions,
    ...(input.sessionPage ? { sessionPage: input.sessionPage } : {}),
    models: (input.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
      ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      reasoningEfforts: model.reasoningEfforts
    })),
    warnings: [
      ...(input.desktopReady === false ? ["Codex/ChatGPT Desktop 未就绪；RabiRoute 不会启动备用 Runtime，请先打开 Desktop。"] : []),
      ...(codexBins.length === 0 ? ["未发现项目锁定的 @openai/codex；已有 Desktop 任务仍可投递，但无法从新名称创建空任务。"] : []),
      ...(input.sessionWarning ? [input.sessionWarning] : [])
    ]
  };
}
export async function scanCodexAgentAdapter(ctx:AgentManagerApiContext,options:AgentScanOptions={}) {
const runtime = createCodexRuntime({ desktopBridgeOptions: { requestTimeoutMs: getTimeoutMs("agent.codex.catalogIpc", 1200) } });
const { listCodexModels, listCodexThreads } = runtime;
try {
const codexLimit = Math.max(1, Math.min(500, Math.floor(options.codexLimit ?? 200)));
const codexOffset = Math.max(0, Math.floor(options.codexOffset ?? 0));
const codexQuery = String(options.codexQuery || "").trim() || undefined;
const codexCatalogTimeoutMs = options.codexCatalogTimeoutMs ?? getTimeoutMs("agent.codex.catalog", 8000);
const performanceOperations: AgentScanPerformanceOperation[] = [];
const runtimes = getRuntimeList(ctx);
let codexDesktopReady = false;

const desktopReadyStartedAt = performance.now();
let desktopReadyFailed = false;
try {
    codexDesktopReady = await (ctx.isCodexDesktopReady ?? runtime.isCodexDesktopReady)();
    desktopReadyFailed = !codexDesktopReady;
  } finally {
    performanceOperations.push({
      operation: PERFORMANCE_OPERATIONS.managerAgentScanDesktopReady,
      durationMs: performance.now() - desktopReadyStartedAt,
      error: desktopReadyFailed
    });
  }
const shouldReadCodexModels = codexDesktopReady && (ctx.listCodexModels != null || ctx.codexSessions == null);
const codexModelsPromise = shouldReadCodexModels
    ? (ctx.listCodexModels ?? listCodexModels)(ctx.rootDir, codexCatalogTimeoutMs)
        .then((models) => ({ models, error: "" }))
        .catch((error) => ({ models: [] as CodexModelCatalogEntry[], error: error instanceof Error ? error.message : String(error) }))
    : Promise.resolve({ models: [] as CodexModelCatalogEntry[], error: "" });
let codexSessionWarning = "";
let discoveredCodexSessions: AgentScanSession[] = [];
if (!ctx.codexSessions) {
    const catalogStartedAt = performance.now();
    let catalogFailed = false;
    const catalogController = new AbortController();
    let catalogTimer: NodeJS.Timeout | undefined;
    try {
      const listSessions = ctx.listCodexSessions ?? (async (
        query: AgentSessionPageQuery,
        listOptions?: { signal?: AbortSignal }
      ) => (await listCodexThreads({
        query: query.query,
        limit: query.limit,
        offset: query.offset,
        allowedWorkspaces: [],
        signal: listOptions?.signal
      })).map((thread) => ({
        id: thread.id,
        name: thread.title,
        projectPath: thread.cwd,
        updatedAt: thread.updatedAt
      })));
      const timeout = new Promise<never>((_resolve, reject) => {
        catalogTimer = setTimeout(() => {
          catalogController.abort();
          reject(new Error(`Codex Desktop task catalog timed out after ${codexCatalogTimeoutMs} ms.`));
        }, codexCatalogTimeoutMs);
      });
      discoveredCodexSessions = await Promise.race([
        listSessions({
          limit: codexLimit + 1,
          offset: codexOffset,
          query: codexQuery
        }, { signal: catalogController.signal }),
        timeout
      ]);
    } catch (error) {
      catalogFailed = true;
      codexSessionWarning = catalogController.signal.aborted
        ? `读取 Codex Desktop 任务目录超时（${codexCatalogTimeoutMs} ms）；页面已继续加载，请稍后点击扫描重试。`
        : `读取 Codex Desktop 任务失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (catalogTimer) clearTimeout(catalogTimer);
      performanceOperations.push({
        operation: PERFORMANCE_OPERATIONS.managerAgentScanCodexCatalog,
        durationMs: performance.now() - catalogStartedAt,
        error: catalogFailed
      });
    }
  }
const codexModelRead = await codexModelsPromise;
const rawCodexSessions = ctx.codexSessions ?? discoveredCodexSessions;
const codexHasMore = rawCodexSessions.length > codexLimit;
const codexSessions = rawCodexSessions.slice(0, codexLimit);
const codexSessionPage: AgentSessionPage = {
    offset: codexOffset,
    limit: codexLimit,
    returned: codexSessions.length,
    hasMore: codexHasMore,
    ...(codexHasMore ? { nextOffset: codexOffset + codexSessions.length } : {})
  };
const codexSessionNames = [...new Set(codexSessions.map((session) => session.name))];
const codexBins = ctx.codexBins ?? await detectCodexBins(ctx.rootDir);
const cwdOptions=ctx.cwdOptions??collectAgentCwdOptions(ctx.rootDir,runtimes,['codexCwd']);
const projects=ctx.projects??projectOptionsFromPaths([...cwdOptions,...codexSessions.flatMap(session=>session.projectPath?[session.projectPath]:[])]);
const threadNames=[...new Set([...codexSessionNames,...runtimes.flatMap(runtime=>runtime.definition.codexThreadName?[runtime.definition.codexThreadName]:[])])];
return {agents:{codex:buildCodexAgentScan({manifest:ctx.manifest,codexBins,projects,sessions:codexSessions,sessionPage:codexSessionPage,desktopReady:codexDesktopReady,models:codexModelRead.models,sessionWarning:[codexSessionWarning,codexModelRead.error?`读取 Codex 模型目录失败：${codexModelRead.error}`:''].filter(Boolean).join('；')})},cwdOptions,threadNames,__performanceOperations:performanceOperations};
} finally { await runtime.disposeCodexAdapterTransport(); }
}
