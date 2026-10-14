import { computed, reactive } from "vue";
import type { AgentScanResult, AgentScanSession, GatewayDefinition } from "./types";

export type GrokBotRouteConnection = Pick<GatewayDefinition,
  "id" | "grokBotBackendUrl" | "grokBotProfilePath" | "grokBotAgentId">;
export type GrokBotScanOptions = { offset?: number; limit?: number; query?: string };
const sessionPageLimit = 100;
export const maxGrokBotSessionItems = 1000;

function connectionKey(connection: GrokBotRouteConnection): string {
  return JSON.stringify([connection.id, connection.grokBotBackendUrl?.trim() || "",
    connection.grokBotProfilePath?.trim() || "", connection.grokBotAgentId || ""]);
}

export function grokBotScanParameters(connection: GrokBotRouteConnection, options: GrokBotScanOptions = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (connection.grokBotBackendUrl?.trim()) params.set("grokBotBackendUrl", connection.grokBotBackendUrl.trim());
  if (connection.grokBotProfilePath?.trim()) params.set("grokBotProfilePath", connection.grokBotProfilePath.trim());
  if (connection.grokBotAgentId) params.set("grokBotAgentId", connection.grokBotAgentId);
  if (options.offset != null) params.set("grokBotOffset", String(options.offset));
  if (options.limit != null) params.set("grokBotLimit", String(options.limit));
  if (options.query?.trim()) params.set("grokBotQuery", options.query.trim());
  return params;
}

export async function fetchGrokBotAgentScan(connection: GrokBotRouteConnection, options: GrokBotScanOptions = {},
  fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<AgentScanResult> {
  const params = grokBotScanParameters(connection, options);
  const response = await fetcher(`/api/scan/agents/grokBot${params.size ? `?${params}` : ""}`, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `Grok Bot 扫描失败（HTTP ${response.status}），请恢复原服务后重新扫描。`);
  const scan = body.agents?.grokBot as AgentScanResult | undefined;
  if (!scan || scan.type !== "grokBot") throw new Error("未取得 Grok Bot 会话目录，请恢复原服务后重新扫描。");
  return scan;
}

export function mergeGrokBotSessionPage(current: AgentScanResult | null, next: AgentScanResult, append: boolean): AgentScanResult {
  const sessions = new Map<string, AgentScanSession>();
  for (const session of [...(append ? current?.sessions ?? [] : []), ...(next.sessions ?? [])]) {
    if (session.id) sessions.set(session.id, session);
  }
  return { ...next, sessions: [...sessions.values()].slice(0, maxGrokBotSessionItems) };
}

export function selectGrokBotRouteSession(gateway: GatewayDefinition, sessions: readonly AgentScanSession[], value: unknown): boolean {
  if (value == null || value === "") {
    gateway.grokBotSessionId = "";
    gateway.grokBotSessionName = "";
    gateway.grokBotAgentId = "";
    return true;
  }
  if (typeof value !== "string") return false;
  const session = sessions.find(item => item.id === value);
  if (!session?.id || !session.ownerId) return false;
  gateway.grokBotSessionId = session.id;
  gateway.grokBotSessionName = session.name;
  gateway.grokBotAgentId = session.ownerId;
  return true;
}

export function grokBotSessionPickerItems(gateway: GatewayDefinition | null, sessions: readonly AgentScanSession[]) {
  const items = sessions.filter(session => session.id && session.ownerId).map(session => ({
    title: session.name,
    value: session.id!,
    subtitle: [session.ownerId, session.updatedAt].filter(Boolean).join(" · "),
    props: { disabled: false }
  }));
  if (gateway?.grokBotSessionId && !items.some(item => item.value === gateway.grokBotSessionId)) {
    items.unshift({ title: gateway.grokBotSessionName || "已保存的 Grok Bot 会话", value: gateway.grokBotSessionId,
      subtitle: "已保存；重新扫描后核对原会话", props: { disabled: true } });
  }
  return items;
}

/** Owns only a bounded UI scan cache. Draft edits and selection never start scans or create sessions. */
export function createGrokBotRouteScan(getConnection: () => GrokBotRouteConnection, fetcher: typeof fetch = fetch) {
  const state = reactive({ result: null as AgentScanResult | null, loading: false, error: "", queryDraft: "", appliedQuery: "", sourceKey: "" });
  let revision = 0;
  let requestSequence = 0;
  let activeRequest: AbortController | undefined;
  let disposed = false;
  const needsRefresh = computed(() => Boolean(state.sourceKey && state.sourceKey !== connectionKey(getConnection())));
  const limitReached = computed(() => (state.result?.sessions?.length ?? 0) >= maxGrokBotSessionItems);

  function seed(scan: AgentScanResult | undefined, connection: GrokBotRouteConnection, expectedRevision: number): void {
    if (disposed || !scan || revision !== expectedRevision || connectionKey(connection) !== connectionKey(getConnection())) return;
    state.result = mergeGrokBotSessionPage(null, scan, false);
    state.sourceKey = connectionKey(connection);
    state.appliedQuery = "";
    state.error = "";
  }

  async function scan(options: GrokBotScanOptions, append: boolean): Promise<void> {
    if (disposed) return;
    const connection = { ...getConnection() };
    const key = connectionKey(connection);
    const sequence = ++requestSequence;
    revision += 1;
    activeRequest?.abort();
    const controller = new AbortController();
    activeRequest = controller;
    state.loading = true;
    state.error = "";
    try {
      const next = await fetchGrokBotAgentScan(connection, options, fetcher, controller.signal);
      if (disposed || sequence !== requestSequence) return;
      if (key !== connectionKey(getConnection())) {
        state.error = "Grok Bot 连接或筛选已修改，请按当前设置重新扫描。";
        return;
      }
      state.result = mergeGrokBotSessionPage(state.result, next, append);
      state.sourceKey = key;
      state.appliedQuery = options.query || "";
    } catch (error) {
      if (!disposed && sequence === requestSequence) state.error = error instanceof Error ? error.message : "Grok Bot 扫描失败，请恢复原服务后重新扫描。";
    } finally {
      if (sequence === requestSequence) { state.loading = false; activeRequest = undefined; }
    }
  }

  return {
    state, needsRefresh, limitReached,
    get revision() { return revision; },
    seed,
    refresh(query = state.queryDraft) { return scan({ offset: 0, limit: sessionPageLimit, query }, false); },
    async loadMore(): Promise<void> {
      const page = state.result?.sessionPage;
      if (disposed || state.loading || needsRefresh.value || limitReached.value || !page?.hasMore || page.nextOffset == null) return;
      await scan({ offset: page.nextOffset, limit: page.limit, query: state.appliedQuery }, true);
    },
    dispose(): void { disposed = true; requestSequence += 1; activeRequest?.abort(); state.loading = false; }
  };
}
