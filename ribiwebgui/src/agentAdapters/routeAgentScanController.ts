import { ref } from "vue";
import type { AgentAdapterType, AgentScanResult, GatewayDefinition } from "../types";
import type { AgentAdapterCatalogEntry } from "./agentAdapterCatalog";
import type { AgentCardScanOptions, AgentCardScanState } from "./agentAdapterCardContext";
import { userFacingError } from "../userFacingError";

type Observation = {
  owner: string; result: AgentScanResult; cwdOptions: string[];
  threadNames: string[]; copilotSessions: Array<{ name: string; cwd?: string; userNamed?: boolean }>;
  copilotBins: string[]; marvisAppIds: string[];
};
type ScanRequest = { routeId: string; owner: string; controller: AbortController };
function emptyState(): AgentCardScanState {
  return { threadNames: [], cwdOptions: [], copilotSessions: [], copilotBins: [], marvisAppIds: [], agents: {}, loading: false };
}

/** Page-owned read requests. Route saves and native provider lifetimes keep their original owners. */
export function createRouteAgentScanController(input: Readonly<{
  route(): GatewayDefinition | undefined;
  catalog(): readonly AgentAdapterCatalogEntry[];
  fetcher?: typeof fetch;
}>) {
  const state = ref(emptyState());
  const loading = ref<Record<string, boolean>>({});
  const errors = ref<Record<string, string>>({});
  const enteredOwners = new Set<string>();
  const pending = new Map<AgentAdapterType, ScanRequest>();
  const observations = new Map<AgentAdapterType, Observation>();
  let routeId: string | undefined;
  let disposed = false;

  function rebuild(): void {
    const all = [...observations.values()];
    state.value = {
      agents: Object.fromEntries([...observations].map(([type, value]) => [type, value.result])),
      cwdOptions: [...new Set(all.flatMap(value => value.cwdOptions))],
      threadNames: [...new Set(all.flatMap(value => value.threadNames))],
      copilotSessions: all.flatMap(value => value.copilotSessions),
      copilotBins: [...new Set(all.flatMap(value => value.copilotBins))],
      marvisAppIds: [...new Set(all.flatMap(value => value.marvisAppIds))],
      loading: pending.size > 0
    };
  }

  function synchronize(): void {
    const nextRouteId = input.route()?.id;
    if (nextRouteId !== routeId) {
      for (const request of pending.values()) request.controller.abort();
      pending.clear(); observations.clear(); enteredOwners.clear();
      loading.value = {}; errors.value = {}; routeId = nextRouteId;
    }
    const owners = new Map(input.catalog().map(provider => [provider.type, provider.renderer.key]));
    for (const [type, request] of pending) {
      if (owners.get(type) === request.owner) continue;
      request.controller.abort(); pending.delete(type); delete loading.value[type];
      enteredOwners.delete(request.owner);
    }
    for (const [type, observation] of observations) {
      if (owners.get(type) === observation.owner) continue;
      observations.delete(type); delete errors.value[type]; enteredOwners.delete(observation.owner);
    }
    rebuild();
  }

  function isCurrent(type: AgentAdapterType, request: ScanRequest): boolean {
    return !disposed && !request.controller.signal.aborted && pending.get(type) === request
      && input.route()?.id === request.routeId
      && input.catalog().find(provider => provider.type === type)?.renderer.key === request.owner;
  }

  async function scan(type: AgentAdapterType, options: AgentCardScanOptions = {}): Promise<void> {
    if (disposed) return;
    synchronize();
    const route = input.route(), provider = input.catalog().find(item => item.type === type);
    if (!route || pending.has(type)) return;
    if (!provider) { errors.value[type] = "对应 Agent 插件未启用、未安装或加载失败，原配置与主控选择已保留。"; return; }
    const request: ScanRequest = { routeId: route.id, owner: provider.renderer.key, controller: new AbortController() };
    pending.set(type, request); loading.value[type] = true; errors.value[type] = ""; rebuild();
    try {
      const params = provider.renderer.agentScanQuery?.(route, options) ?? new URLSearchParams();
      const response = await (input.fetcher ?? fetch)(`/api/agent-adapters/scan/${encodeURIComponent(type)}${params.size ? `?${params}` : ""}`, { signal: request.controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || `Agent 扫描失败（HTTP ${response.status}）`);
      const result = data.agents?.[type] as AgentScanResult | undefined;
      if (!result || result.type !== type) throw new Error("未取得此 Agent 的扫描结果，请恢复对应插件后刷新。");
      if (!isCurrent(type, request)) return;
      const previous = observations.get(type)?.result;
      const sessions = options.append ? [...(previous?.sessions ?? []), ...(result.sessions ?? [])] : result.sessions;
      observations.set(type, {
        owner: request.owner,
        result: { ...result, ...(sessions ? { sessions: [...new Map(sessions.map(session => [session.id || `${session.name}:${session.projectPath || ""}:${session.updatedAt || ""}`, session])).values()] } : {}) },
        cwdOptions: data.cwdOptions ?? [], threadNames: data.threadNames ?? [], copilotSessions: data.copilotSessions ?? [],
        copilotBins: data.copilotBins ?? [], marvisAppIds: data.marvisAppIds ?? []
      });
    } catch (error) {
      if (isCurrent(type, request)) errors.value[type] = userFacingError(error);
    } finally {
      if (pending.get(type) === request) { pending.delete(type); loading.value[type] = false; rebuild(); }
    }
  }

  async function scanAll(): Promise<void> {
    if (disposed) return;
    synchronize();
    await Promise.allSettled(input.catalog().map(provider => scan(provider.type)));
  }

  function enter(): void {
    if (disposed) return;
    synchronize();
    if (!input.route()) return;
    for (const provider of input.catalog()) {
      if (enteredOwners.has(provider.renderer.key)) continue;
      enteredOwners.add(provider.renderer.key);
      void scan(provider.type);
    }
  }

  function dispose(): void {
    disposed = true;
    for (const request of pending.values()) request.controller.abort();
    pending.clear(); observations.clear(); enteredOwners.clear(); loading.value = {}; errors.value = {}; state.value = emptyState();
  }

  return { state, loading, errors, scan, scanAll, enter, dispose };
}
