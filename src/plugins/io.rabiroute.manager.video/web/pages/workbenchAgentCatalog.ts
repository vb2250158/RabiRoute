// Agent target directory for workflow nodes: installed CLIs, already connected
// Agent sessions on this computer, and the ones published by other computers.
// Discovery only reads; every source keeps its own failure instead of hiding peers.
import { ref } from "vue";
import { isAgentThreadCapableAdapter } from "@shared/agentAdapterCapabilities";
import { agentInstanceDisplayName, normalizeAgentInstanceBinding, type AgentInstance, type AgentInstanceBinding } from "@shared/agentInstance";
import { agentHistoryEvents, agentHistoryMessages, agentHistoryNextCursor } from "../../../../../ribiwebgui/src/agentSessionHistory";
import { readAgentInstanceDirectory, type AgentDirectoryDiagnostic } from "../../../../../ribiwebgui/src/connectedAgentInstances";
import { postRouteAgentThreadAction } from "../../../../../ribiwebgui/src/routeAgentThreadClient";

const detectionError = "暂时无法检测本机 Agent。";
const directoryError = "无法读取已接入的 Agent 会话。";

export type WorkbenchCliProvider = {
  id: string;
  label: string;
  installUrl: string;
  installed: boolean;
  ready?: boolean;
  models: { id: string; label: string }[];
};

/** Node identity for one selectable Agent: a local CLI or an existing Agent session. */
export type WorkbenchAgentSelection =
  | { kind: "cli"; provider: string; model?: string }
  | { kind: "session"; provider: string; threadId: string; instanceBinding?: AgentInstanceBinding; cwd?: string; deviceName?: string; agentName?: string };

export type WorkbenchAgentGroup = "cli" | "local" | "remote";
export type WorkbenchAgentEntry = {
  key: string;
  group: WorkbenchAgentGroup;
  kind: "cli" | "session";
  provider: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  installUrl?: string;
  models?: { id: string; label: string }[];
  binding?: AgentInstanceBinding;
  deviceName?: string;
  agentName?: string;
  workspace?: string;
  sessionId?: string;
};

export type WorkbenchAgentCatalog = {
  entries: WorkbenchAgentEntry[];
  diagnostics: AgentDirectoryDiagnostic[];
  error: string;
};

export const groupLabels: Record<WorkbenchAgentGroup, string> = {
  cli: "本机 CLI",
  local: "本机已接入 Agent",
  remote: "其他电脑",
};

export const workbenchCliProviders = ref<WorkbenchCliProvider[]>([]);
export const workbenchAgentCatalog = ref<WorkbenchAgentCatalog>({ entries: [], diagnostics: [], error: "" });
export const workbenchAgentLoading = ref(false);
let workbenchAgentPending: Promise<void> | undefined;
let catalogLoaded = false;

function cliEntry(provider: WorkbenchCliProvider): WorkbenchAgentEntry {
  const unavailable = !provider.installed ? "（未安装）" : !provider.ready ? "（需检查）" : "";
  return {
    key: `cli:${provider.id}`,
    group: "cli",
    kind: "cli",
    provider: provider.id,
    label: `${provider.label}${unavailable}`,
    ...(provider.installUrl ? { installUrl: provider.installUrl } : {}),
    disabled: !provider.ready,
    models: provider.models,
  };
}

/** Only adapters that publish Agent thread control can own a node; a disabled Agent stays listed but unselectable. */
function instanceEntry(instance: AgentInstance, agent: AgentInstance["agents"][number]): WorkbenchAgentEntry | undefined {
  const provider = agent.provider === "codex-desktop" ? "codex" : agent.provider;
  if (!isAgentThreadCapableAdapter(provider) || agent.enabled === false) return undefined;
  let binding: AgentInstanceBinding | undefined;
  try {
    binding = normalizeAgentInstanceBinding({ instanceId: instance.instanceId, agentId: agent.agentId, ...(instance.ownerDeviceId ? { ownerDeviceId: instance.ownerDeviceId } : {}) });
  } catch {
    return undefined;
  }
  if (!binding) return undefined;
  const remote = Boolean(instance.ownerDeviceId);
  const deviceName = agentInstanceDisplayName(instance);
  return {
    key: `session:${instance.ownerDeviceId ?? "local"}:${instance.instanceId}:${agent.agentId}`,
    group: remote ? "remote" : "local",
    kind: "session",
    provider,
    label: agent.name || provider,
    ...(remote ? { detail: deviceName } : agent.workspace ? { detail: agent.workspace } : {}),
    binding,
    ...(remote ? { deviceName } : {}),
    agentName: agent.name || provider,
    ...(agent.workspace ? { workspace: agent.workspace } : {}),
    ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
  };
}

/** A connected instance that still lists no Agent row is not selectable; the caller keeps its diagnostic. */
export function agentEntriesFromInstances(instances: readonly AgentInstance[]): WorkbenchAgentEntry[] {
  const entries = new Map<string, WorkbenchAgentEntry>();
  for (const instance of instances) {
    if (!instance || !Array.isArray(instance.agents) || !instance.connected || instance.enabled === false) continue;
    for (const agent of instance.agents) {
      const entry = instanceEntry(instance, agent);
      if (entry) entries.set(entry.key, entry);
    }
  }
  return [...entries.values()];
}

export function workbenchAgentGroups(entries: readonly WorkbenchAgentEntry[]): { group: WorkbenchAgentGroup; label: string; entries: WorkbenchAgentEntry[] }[] {
  return (Object.keys(groupLabels) as WorkbenchAgentGroup[])
    .map(group => ({ group, label: groupLabels[group], entries: entries.filter(entry => entry.group === group) }))
    .filter(row => row.entries.length > 0);
}

/** One read per source; a CLI failure never removes the connected sessions of another computer. */
export async function loadWorkbenchAgentCatalog(refresh = false): Promise<void> {
  if (workbenchAgentPending) return workbenchAgentPending;
  if (catalogLoaded && !refresh) return;
  workbenchAgentLoading.value = true;
  workbenchAgentPending = (async () => {
    const [cli, directory] = await Promise.allSettled([
      fetch(`/api/video/v2/cli${refresh ? "?refresh=1" : ""}`, { cache: "no-store" }).then(async response => {
        if (!response.ok) throw new Error(detectionError);
        return (await response.json()).providers as WorkbenchCliProvider[];
      }),
      readAccessDirectory(),
    ]);
    const providers = cli.status === "fulfilled" ? cli.value : [];
    const instances = directory.status === "fulfilled" ? directory.value.instances : [];
    const diagnostics = directory.status === "fulfilled" ? directory.value.diagnostics : [];
    const entries = [...providers.map(cliEntry), ...agentEntriesFromInstances(instances)];
    const error = [cli.status === "rejected" ? detectionError : "", directory.status === "rejected" ? directoryError : ""].filter(Boolean).join(" ");
    workbenchCliProviders.value = providers;
    workbenchAgentCatalog.value = { entries, diagnostics, error };
    catalogLoaded = cli.status === "fulfilled" || directory.status === "fulfilled";
  })().finally(() => {
    workbenchAgentPending = undefined;
    workbenchAgentLoading.value = false;
  });
  return workbenchAgentPending;
}

/** Connected hosts publish their sessions behind the same WebGUI access token the rest of the catalogue uses. */
async function readAccessDirectory() {
  const access = await fetch("/api/webgui-access", { cache: "no-store" });
  const body = await access.json();
  if (!access.ok) throw new Error(body?.message || directoryError);
  const headers: Record<string, string> = typeof body?.data?.token === "string" ? { "x-rabiroute-webgui-token": body.data.token } : {};
  return readAgentInstanceDirectory(fetch, headers);
}

export function workbenchAgentEntry(entries: readonly WorkbenchAgentEntry[], key: string): WorkbenchAgentEntry | undefined {
  return entries.find(entry => entry.key === key);
}

/** Session identity is the binding plus the exact thread; a CLI node carries no binding at all. */
export function agentSelectionFromConfig(config: Record<string, any> | undefined): WorkbenchAgentSelection | undefined {
  if (!config) return undefined;
  if (config.cli && typeof config.cli.provider === "string" && config.cli.provider) {
    return { kind: "cli", provider: config.cli.provider, ...(typeof config.cli.model === "string" && config.cli.model ? { model: config.cli.model } : {}) };
  }
  const target = config.target;
  if (target && typeof target.agentAdapter === "string" && target.agentAdapter && typeof target.threadId === "string" && target.threadId) {
    return {
      kind: "session",
      provider: target.agentAdapter,
      threadId: target.threadId,
      ...(target.instanceBinding ? { instanceBinding: target.instanceBinding } : {}),
      ...(typeof target.cwd === "string" && target.cwd ? { cwd: target.cwd } : {}),
      ...(typeof target.deviceName === "string" && target.deviceName ? { deviceName: target.deviceName } : {}),
      ...(typeof target.agentName === "string" && target.agentName ? { agentName: target.agentName } : {}),
    };
  }
  return undefined;
}

/** Switching target kind removes the other kind's fields so a node never claims two execution owners. */
export function applyAgentSelection(config: Record<string, any>, selection: WorkbenchAgentSelection | undefined): Record<string, any> {
  const next = JSON.parse(JSON.stringify(config ?? {}));
  if (selection?.kind === "cli") {
    delete next.target;
    next.cli = { provider: selection.provider, ...(selection.model ? { model: selection.model } : {}) };
    return next;
  }
  if (selection?.kind === "session") {
    delete next.cli;
    next.target = {
      agentAdapter: selection.provider,
      threadId: selection.threadId,
      ...(selection.instanceBinding ? { instanceBinding: selection.instanceBinding } : {}),
      ...(selection.cwd ? { cwd: selection.cwd } : {}),
      ...(selection.deviceName ? { deviceName: selection.deviceName } : {}),
      ...(selection.agentName ? { agentName: selection.agentName } : {}),
    };
    return next;
  }
  delete next.cli;
  delete next.target;
  return next;
}

/** Match the saved node back to a catalogue row; an unknown saved target stays visible through its own values. */
export function selectedEntryKey(entries: readonly WorkbenchAgentEntry[], selection: WorkbenchAgentSelection | undefined): string {
  if (!selection) return "";
  if (selection.kind === "cli") return `cli:${selection.provider}`;
  const binding = selection.instanceBinding;
  const key = entries.find(entry => entry.kind === "session" && entry.provider === selection.provider
    && (!binding || entry.binding?.instanceId === binding.instanceId && entry.binding.agentId === binding.agentId && entry.binding.ownerDeviceId === binding.ownerDeviceId))?.key;
  return key ?? `session:unknown:${selection.provider}`;
}

export type WorkbenchAgentSession = { id: string; name: string; workspace?: string };

/** Native sessions of the chosen Agent. Remote hosts answer through their own Manager; nothing is invented. */
export async function loadWorkbenchAgentSessions(entry: WorkbenchAgentEntry, signal?: AbortSignal): Promise<WorkbenchAgentSession[]> {
  if (entry.kind !== "session" || !entry.provider) return [];
  const payload = { action: "list", agentAdapter: entry.provider, limit: 50 };
  const body = entry.binding?.ownerDeviceId
    ? await postRemote(entry, payload, signal)
    : await postLocal(payload, signal);
  const rows = Array.isArray(body?.threads) ? body.threads : Array.isArray(body?.data?.threads) ? body.data.threads : [];
  return rows.flatMap((row: any) => {
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id) return [];
    const name = typeof row?.name === "string" && row.name.trim() ? row.name : typeof row?.title === "string" && row.title.trim() ? row.title : id;
    const workspace = typeof row?.cwd === "string" ? row.cwd : typeof row?.projectPath === "string" ? row.projectPath : undefined;
    return [{ id, name, ...(workspace ? { workspace } : {}) }];
  });
}

async function postLocal(payload: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch("/api/agent/threads", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.code === -1) throw new Error(body?.message || "读取本机 Agent 会话失败。");
  return body?.data ?? body;
}

async function postRemote(entry: WorkbenchAgentEntry, payload: Record<string, unknown>, signal?: AbortSignal) {
  const binding = entry.binding!;
  const access = await fetch("/api/webgui-access", { signal, cache: "no-store" });
  const token = (await access.json())?.data?.token;
  const response = await fetch(`/api/lan-agent/instances/${encodeURIComponent(binding.instanceId)}/agents/${encodeURIComponent(binding.agentId)}/threads`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", ...(typeof token === "string" ? { "x-rabiroute-webgui-token": token } : {}) },
    body: JSON.stringify({ ...payload, agentAdapter: entry.provider }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.code !== 0) throw new Error(body?.message || "读取其他电脑的 Agent 会话失败。");
  if (body.result?.statusCode >= 400) throw new Error(body.result?.data?.message || "其他电脑拒绝了会话列表请求。");
  return body.result?.data ?? body;
}

/** Native conversation of the exact bound session; the owning provider decides the page shape. */
export type WorkbenchAgentMessage = { id: string; role: "user" | "assistant"; text: string; time?: string };

function routeTarget(selection: Extract<WorkbenchAgentSelection, { kind: "session" }>) {
  return {
    id: `${selection.provider}:${selection.threadId}`,
    provider: selection.provider,
    ...(selection.instanceBinding ? { binding: selection.instanceBinding } : {}),
  };
}

function conversationPage(result: any) {
  return result?.data?.history ?? result?.history ?? result;
}

export async function loadWorkbenchAgentHistory(
  selection: WorkbenchAgentSelection | undefined, cursor?: string, limit = 30, signal?: AbortSignal,
): Promise<{ messages: WorkbenchAgentMessage[]; cursor: string | null }> {
  if (selection?.kind !== "session") return { messages: [], cursor: null };
  const result = await postRouteAgentThreadAction(
    { action: "read", threadId: selection.threadId, history: { limit, ...(cursor ? { cursor } : {}) } },
    routeTarget(selection) as any,
    { accessToken: () => "", signal },
  );
  const page = conversationPage(result) ?? {};
  const events = agentHistoryEvents(selection.provider, page);
  return {
    messages: agentHistoryMessages(selection.provider, events).map(message => ({
      id: message.id, role: message.role, text: message.text, ...(message.time ? { time: message.time } : {}),
    })),
    cursor: agentHistoryNextCursor(selection.provider, page),
  };
}

/** A message written to the real session: it must be the exact target the node is bound to. */
export async function sendWorkbenchAgentMessage(
  selection: WorkbenchAgentSelection | undefined, prompt: string, deliveryId: string, signal?: AbortSignal,
): Promise<any> {
  if (selection?.kind !== "session") throw new Error("请先为此节点选择一个 Agent 会话。");
  const text = prompt.trim();
  if (!text) throw new Error("请输入要发送的内容。");
  if (text.length > 20000) throw new Error("消息最多 20,000 字符。");
  return postRouteAgentThreadAction(
    { action: "send", threadId: selection.threadId, prompt: text, deliveryId, ...(selection.cwd ? { cwd: selection.cwd } : {}) },
    routeTarget(selection) as any,
    { accessToken: () => "", signal },
  );
}
