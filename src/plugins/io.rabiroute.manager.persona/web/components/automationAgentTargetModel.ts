import { readAgentInstanceDirectory } from "../../../../../ribiwebgui/src/connectedAgentInstances";
import { normalizeAgentInstanceBinding, type AgentInstance } from "@shared/agentInstance";
import { remoteAgentTargetKey, type RouteAgentTarget } from "@shared/routeAgentTargets";
import { normalizeAgentDeliveryTarget, normalizeDsBotConnectionOrigin, type AgentSessionDestination, type AgentDsBotDestination } from "@shared/agentDeliveryTarget";

export type SessionTarget = AgentSessionDestination;
export type DeliverySession = {
  id: string; name?: string; projectPath?: string; cwd?: string; title?: string;
  kind?: string | number; memberAgentIds?: string[]; nativeAgentId?: string; nativeAgentName?: string;
};

export function isGroupSession(row: DeliverySession): boolean {
  return row.kind === "ROOM" || row.kind === "GROK_BOT_AGENT_KIND_ROOM" || row.kind === 2 || row.kind === "2";
}

export function deliverySessions(rows: readonly DeliverySession[], target: SessionTarget): DeliverySession[] {
  if (target.agentAdapter !== "grokBot") return [...rows];
  return rows.filter(row => target.deliveryType === "group" ? isGroupSession(row) : !isGroupSession(row));
}

export function senderIdentities(rows: readonly DeliverySession[], room?: DeliverySession, group = true): DeliverySession[] {
  const members = new Set(room?.memberAgentIds ?? []);
  return [...new Map(rows.filter(row => !isGroupSession(row) && row.nativeAgentId && (!group || members.has(row.nativeAgentId)))
    .map(row => [row.nativeAgentId!, row])).values()];
}

export function changeDeliveryType(target: SessionTarget, deliveryType: "private" | "group"): SessionTarget {
  const { senderAgentId, senderAgentName, ...rest } = target;
  return { ...rest, deliveryType, sendMode: "direct", sessionId: "", sessionName: "", workspace: "" };
}

export function changeSendMode(target: SessionTarget, sendMode: "direct" | "identity"): SessionTarget {
  const { senderAgentId, senderAgentName, ...rest } = target;
  return { ...rest, ...(target.agentAdapter === "grokBot" ? { deliveryType: target.deliveryType ?? "private" } : {}), sendMode };
}

export function chooseDeliverySession(target: SessionTarget, row: DeliverySession): SessionTarget | undefined {
  if (!deliverySessions([row], target).length) return undefined;
  const { senderAgentId, senderAgentName, ...rest } = target;
  return { ...rest, ...(target.agentAdapter === "grokBot" ? { deliveryType: target.deliveryType ?? "private", sendMode: target.sendMode ?? "direct" } : {}),
    sessionId: row.id, sessionName: row.name || row.title || row.id, workspace: row.projectPath || row.cwd || "" };
}

export function chooseSenderIdentity(target: SessionTarget, rows: readonly DeliverySession[], room: DeliverySession | undefined, nativeAgentId: string): SessionTarget | undefined {
  if (target.sendMode !== "identity") return undefined;
  const sender = senderIdentities(rows, room, target.deliveryType === "group").find(row => row.nativeAgentId === nativeAgentId);
  return sender ? { ...target, senderAgentId: nativeAgentId, senderAgentName: sender.nativeAgentName || sender.name || sender.title || nativeAgentId } : undefined;
}

export type DsBotCatalog = { dshBaseUrl?: string; schemaVersion: 1; botScopeId: string; runtimeId: string; bots: Array<{ botId: string; botName: string; roleId?: string; workspace?: string }> };

/** Catalog identity comes from the selected DSH owner, never from session names or persona matches. */
export function readDsBotCatalog(value: unknown): DsBotCatalog {
  if (!value || typeof value !== "object") throw new Error("Invalid DSBot catalog");
  const raw = value as Partial<DsBotCatalog>;
  if (raw.schemaVersion !== 1 || typeof raw.botScopeId !== "string" || !raw.botScopeId || typeof raw.runtimeId !== "string" || !raw.runtimeId || !Array.isArray(raw.bots)
    || raw.bots.some(bot => !bot || typeof bot.botId !== "string" || !bot.botId || typeof bot.botName !== "string" || !bot.botName)
    || new Set(raw.bots.map(bot => bot.botId)).size !== raw.bots.length) throw new Error("Invalid DSBot catalog");
  return { schemaVersion: 1, botScopeId: raw.botScopeId, runtimeId: raw.runtimeId, bots: raw.bots, ...(typeof raw.dshBaseUrl === "string" ? { dshBaseUrl: normalizeDsBotConnectionOrigin(raw.dshBaseUrl) } : {}) };
}

export function chooseDsBot(agent: RouteAgentTarget, catalog: DsBotCatalog, botId: string): AgentDsBotDestination | undefined {
  const bot = catalog.bots.find(bot => bot.botId === botId);
  if (!bot || agent.provider !== "dsh" || !agent.id) return undefined;
  const target = normalizeAgentDeliveryTarget({ kind: "ds_bot", agentAdapter: "dsh", agentTargetId: agent.id, botScopeId: catalog.botScopeId, botId: bot.botId, botName: bot.botName,
    ...(agent.binding ? { instanceBinding: agent.binding } : { dshBaseUrl: catalog.dshBaseUrl }) });
  return target.kind === "ds_bot" ? target : undefined;
}

/** Connected owner catalogs provide the binding; target IDs are only generated with the existing owner helper. */
export function dsBotDirectoryTargets(instances: readonly AgentInstance[]): RouteAgentTarget[] {
  const targets = new Map<string, RouteAgentTarget>();
  for (const instance of instances) {
    if (!instance || !Array.isArray(instance.agents) || !instance.connected || instance.enabled === false || instance.local && !instance.ownerDeviceId) continue;
    for (const agent of instance.agents) {
      if (!agent || agent.provider !== "dsh" || agent.enabled === false) continue;
      let binding;
      try { binding = normalizeAgentInstanceBinding({ instanceId: instance.instanceId, agentId: agent.agentId, ...(instance.ownerDeviceId ? { ownerDeviceId: instance.ownerDeviceId } : {}) }); }
      catch { continue; }
      if (!binding) continue;
      const id = remoteAgentTargetKey(binding);
      targets.set(id, { id, provider: "dsh", binding });
    }
  }
  return [...targets.values()];
}

/** Published capabilities add the local DSH target even when an independent persona has no Route. */
export async function availableAutomationDsh(fetcher: typeof fetch): Promise<boolean> {
  const response = await fetcher("/api/agent-adapters/catalog");
  const body = await response.json();
  if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.adapters)) throw new Error(body.message || "Agent provider catalog unavailable");
  return body.data.adapters.some((item: { type?: string; capabilities?: { managedTasks?: { agentThreads?: boolean } } }) => item?.type === "dsh" && item.capabilities?.managedTasks?.agentThreads === true);
}

/** Reuse the authenticated instance directory entry point, including its independent-host failure isolation. */
export async function automationDsBotDirectory(fetcher: typeof fetch) {
  const response = await fetcher("/api/webgui-access");
  const body = await response.json();
  if (!response.ok) throw new Error("Agent directory access unavailable");
  const headers: Record<string, string> = typeof body.data?.token === "string" ? { "x-rabiroute-webgui-token": body.data.token } : {};
  return readAgentInstanceDirectory(fetcher, headers);
}
