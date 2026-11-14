import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {getTimeoutMs} from '@rabiroute/host-api/shared/timeoutSettings';
import type {AgentManagerApiContext,AgentScanOptions,AgentScanResult,AgentScanSession,AgentSessionPage,AgentSessionPageQuery,AgentScanProject,AgentScanPerformanceOperation,CopilotSessionEntry,AstrbotSessionScan,AstrbotLoginTestRequest,MarvisOpenRequest} from '@rabiroute/host-api/agentAdapters/managerTypes';
import {resolvePersistedProjectPath} from '@rabiroute/host-api/shared/projectPaths';
import {agentScanManifestFields,getRuntimeList,projectOptionsFromPaths,normalizeComparablePath,checkHttpEndpoint,collectAgentCwdOptions} from '@rabiroute/host-api/agentAdapters/managerScanShared';
import {listDshModels,listDshAgentPresets,listDshSessions,type DshModelCatalogEntry} from '../dshSessionBridge.js';import {discoverLocalDsh,type DshLocalDiscovery} from '../dshDiscovery.js';
export async function scanDshAgentAdapter(
  ctx: AgentManagerApiContext,
  options: Pick<AgentScanOptions, "dshLimit" | "dshOffset" | "dshQuery" | "dshBaseUrl"> = {}
): Promise<{ agents: { dsh: AgentScanResult }; cwdOptions: string[] }> {
  const dshLimit = Math.max(1, Math.min(500, Math.floor(options.dshLimit ?? 200)));
  const dshOffset = Math.max(0, Math.floor(options.dshOffset ?? 0));
  const dshQuery = String(options.dshQuery || "").trim() || undefined;
  const runtimes = getRuntimeList(ctx);
  const checkEndpoint = ctx.checkHttpEndpoint ?? checkHttpEndpoint;
  const discovery = ctx.discoverLocalDsh?.() ?? discoverLocalDsh();
  const configuredDshUrls = [
    options.dshBaseUrl?.trim().replace(/\/+$/, ""),
    ...runtimes.map((runtime) => runtime.definition.dshBaseUrl?.trim().replace(/\/+$/, ""))
  ].filter(Boolean) as string[];
  const dshUrls = [...new Set([
    ...configuredDshUrls,
    ...discovery.discoveredBaseUrls
  ])];
  const dshEndpoints = await Promise.all(dshUrls.map(async (url) => ({
    label: url.includes("127.0.0.1") || url.includes("localhost") ? "本机 DSH apiproxy" : "DSH apiproxy",
    url,
    // DSH can be busy loading its catalog; a 1.2-second generic probe must not
    // prevent the authenticated session lookup from even attempting recovery.
    healthy: await checkEndpoint(url, getTimeoutMs("agent.dsh.probe", 10000))
  })));
  const configuredBaseUrl = configuredDshUrls[0];
  const healthyConfigured = dshEndpoints.find((endpoint) => endpoint.url === configuredBaseUrl && endpoint.healthy);
  const firstHealthy = dshEndpoints.find((endpoint) => endpoint.healthy);
  const dshBaseUrl = configuredBaseUrl || firstHealthy?.url || discovery.discoveredBaseUrls[0] || "";
  const dshEndpointHealthy = dshEndpoints.some((endpoint) => endpoint.url === dshBaseUrl && endpoint.healthy);
  const dshAnyHealthy = Boolean(firstHealthy);
  const shouldReadDshModels = dshEndpointHealthy && (
    ctx.listDshModels != null
    || (ctx.dshSessions == null && ctx.listDshSessions == null)
  );
  const modelCatalogPromise = shouldReadDshModels
    ? (ctx.listDshModels ?? listDshModels)(dshBaseUrl)
        .then((catalog) => ({ catalog, error: "" }))
        .catch((error) => ({ catalog: { models: [], warnings: [] }, error: error instanceof Error ? error.message : String(error) }))
    : Promise.resolve({ catalog: { models: [], warnings: [] }, error: "" });
  const presetCatalogPromise = dshEndpointHealthy && (ctx.listDshAgentPresets || (ctx.dshSessions == null && ctx.listDshSessions == null))
    ? (ctx.listDshAgentPresets ?? listDshAgentPresets)(dshBaseUrl)
        .then(presets => ({ presets, error: "" }))
        .catch(error => ({ presets: [], error: error instanceof Error ? error.message : String(error) }))
    : Promise.resolve({ presets: [], error: "" });
  const directoryWarnings: string[] = [];
  let dshSessionWarning = "";
  let rawDshSessions: AgentScanSession[] = ctx.dshSessions ?? [];
  if (dshBaseUrl && !ctx.dshSessions && (ctx.listDshSessions || dshEndpointHealthy)) {
    try {
      const listSessions = ctx.listDshSessions ?? (async (query: AgentSessionPageQuery & { baseUrl: string }) => (
        await listDshSessions({
          baseUrl: query.baseUrl,
          query: query.query,
          limit: query.limit,
          offset: query.offset,
          onWarning: warning => directoryWarnings.push(warning)
        })
      ).map((session) => ({
        id: session.id,
        name: session.title,
        projectPath: session.cwd,
        updatedAt: session.updatedAt
      })));
      const query = {
        baseUrl: dshBaseUrl,
        limit: dshLimit + 1,
        offset: dshOffset,
        query: dshQuery
      };
      try {
        rawDshSessions = await listSessions(query);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/HTTP 404\b/i.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
        rawDshSessions = await listSessions(query);
      }
    } catch (error) {
      dshSessionWarning = `读取 DSH 会话失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const dshHasMore = rawDshSessions.length > dshLimit;
  const dshSessions = rawDshSessions.slice(0, dshLimit);
  const dshSessionPage: AgentSessionPage = {
    offset: dshOffset,
    limit: dshLimit,
    returned: dshSessions.length,
    hasMore: dshHasMore,
    ...(dshHasMore ? { nextOffset: dshOffset + dshSessions.length } : {})
  };
  const configuredDshCwds = runtimes
    .map((runtime) => resolvePersistedProjectPath(runtime.definition.dshCwd, ctx.rootDir))
    .filter((value): value is string => Boolean(value));
  const dshProjects = projectOptionsFromPaths([
    ...configuredDshCwds,
    ...dshSessions.map((session) => session.projectPath).filter((value): value is string => Boolean(value))
  ]);
  // Base connectivity belongs to the DSH owner API, not optional Rabi UI/tools.
  const modelRead = await modelCatalogPromise;
  const presetRead = await presetCatalogPromise;
  return {
    agents: { dsh: {
      ...agentScanManifestFields("dsh", ctx.manifest),
      installed: discovery.installed || dshAnyHealthy,
      ...(discovery.installCandidates.length ? { installCandidates: discovery.installCandidates } : {}),
      endpoints: dshEndpoints,
      projects: dshProjects,
      sessions: dshSessions,
      sessionPage: dshSessionPage,
      agentPresets: presetRead.presets,
      models: modelRead.catalog.models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        providerName: model.providerName,
        ...(model.description ? { description: model.description } : {}),
        ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
        reasoningEfforts: model.reasoningEfforts
      })),
      warnings: [
        ...directoryWarnings,
        ...(presetRead.error ? [`读取 DSH 会话模式失败：${presetRead.error}`] : []),
        ...(modelRead.error ? [`读取 DSH 模型目录失败：${modelRead.error}`] : []),
        ...modelRead.catalog.warnings.map((warning) => `DSH 模型目录：${warning}`),
        ...(dshSessionWarning ? [dshSessionWarning] : []),
        ...discovery.warnings,
        ...(configuredBaseUrl && !healthyConfigured && firstHealthy
          ? [`已保存的 DSH 地址 ${configuredBaseUrl} 未响应；本机扫描到 ${firstHealthy.url}。`]
          : []),
        ...(!dshBaseUrl ? ["未配置或发现 DSH owner 地址；请填写 dshBaseUrl，不猜测端口。"]
          : dshAnyHealthy ? [] : ["DSH apiproxy 不可用；请启动 DSH 并确认服务地址。"]),
        ...(dshSessions.length === 0 && !dshSessionWarning ? ["未发现 DSH 会话；保存配置时可按名称和工作目录创建。"] : []),
        "RabiRoute 可以发现、创建、重命名、绑定 DSH 会话，并通过 session.prompt（mode=queue）投递。",
        "DSH 支持主角色、计划秘书、消息处理和独立记忆整理会话；请在当前实例核对任务可用性和实际投递结果。"
      ]
    } },
    cwdOptions: dshProjects.map((project) => project.path)
  };
}
