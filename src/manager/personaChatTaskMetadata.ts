import { getTimeoutMs } from "../shared/timeoutSettings.js";
import type { AgentRequestParty } from "../agentRequests/store.js";
import type { PersonaChatReply, PersonaChatTaskOwner } from "../shared/personaChatHistory.js";
import { codexDesktopDeepLinkForTest, readCodexDesktopThreadsByIds } from "../codexDesktopBridge.js";

export type ChatDeliveryParties = { source: AgentRequestParty; target: AgentRequestParty };
export type PersonaChatTaskMetadataContext = {
  readTasks?: typeof readCodexDesktopThreadsByIds;
  readDeliveryParties?(ids: string[]): Map<string, ChatDeliveryParties>;
  nodeName?(nodeId: string): string | undefined;
  readRemoteTask?(owner: PersonaChatTaskOwner, sessionId: string): Promise<{ id: string; title: string } | undefined>;
};

export function chatTaskOwner(party: AgentRequestParty | undefined, nodeName?: PersonaChatTaskMetadataContext["nodeName"]): PersonaChatTaskOwner | undefined {
  const endpoint = party?.endpoint;
  if (!endpoint) return undefined;
  const nodeId = endpoint.nodeId || endpoint.instanceId;
  return { kind: endpoint.kind, provider: endpoint.provider, agentId: endpoint.agentId,
    ...(nodeId ? { nodeId, nodeName: nodeName?.(nodeId) } : {}) };
}

/** Exact delivery identities enrich old rows without rewriting their append-only ledger. */
export async function enrichPersonaChatTasks(entries: PersonaChatReply[], context: PersonaChatTaskMetadataContext): Promise<PersonaChatReply[]> {
  let deliveries = new Map<string, ChatDeliveryParties>();
  try { deliveries = context.readDeliveryParties?.([...new Set(entries.flatMap(row => row.deliveryId ? [row.deliveryId] : []))]) ?? deliveries; }
  catch { /* Metadata failure must not hide the recorded message. */ }
  const rows = entries.map(entry => {
    const row = { ...entry };
    const parties = entry.deliveryId ? deliveries.get(entry.deliveryId) : undefined;
    for (const side of ["source", "target"] as const) {
      const id = side === "source" ? row.sessionId : row.targetSessionId;
      const party = parties?.[side];
      if (!id || party?.threadId !== id || (party.endpoint && party.endpoint.sessionId !== id)) continue;
      const owner = chatTaskOwner(party, context.nodeName);
      if (side === "source") {
        row.sourceTaskOwner = owner ?? row.sourceTaskOwner;
        row.sessionTitle = row.sessionTitle || (party.threadName !== id ? party.threadName : undefined);
      } else {
        row.targetTaskOwner = owner ?? row.targetTaskOwner;
        row.targetSessionTitle = row.targetSessionTitle || (party.threadName !== id ? party.threadName : undefined);
      }
    }
    return row;
  });
  const references = rows.flatMap(row => [
    ...(row.kind === "user_delivery" || row.kind?.startsWith("aiui_") ? [] : [{ row, side: "source" as const, id: row.sessionId, owner: row.sourceTaskOwner }]),
    ...(row.targetSessionId ? [{ row, side: "target" as const, id: row.targetSessionId, owner: row.targetTaskOwner }] : [])
  ]);
  const local = (owner?: PersonaChatTaskOwner) => !owner || owner.kind === "local" && ["codex", "codex-desktop"].includes(owner.provider);
  let tasks = new Map<string, { id: string; title: string }>();
  try {
    const ids = [...new Set(references.filter(ref => local(ref.owner)).map(ref => ref.id))];
    if (ids.length) tasks = new Map((context.readTasks ?? readCodexDesktopThreadsByIds)(ids).map(task => [task.id, task]));
  } catch { /* Recorded names remain usable while Desktop is unavailable. */ }
  const remote = new Map<string, typeof references>();
  for (const ref of references) {
    const titleKey = ref.side === "source" ? "sessionTitle" : "targetSessionTitle";
    const urlKey = ref.side === "source" ? "taskUrl" : "targetTaskUrl";
    if (local(ref.owner)) {
      const task = tasks.get(ref.id);
      if (task) { ref.row[titleKey] = task.title || ref.row[titleKey]; ref.row[urlKey] = codexDesktopDeepLinkForTest(task.id); }
    } else {
      // A remote ID is never a local Desktop link, even if the IDs happen to match.
      delete ref.row[urlKey];
      if (ref.owner?.kind === "instance" && context.readRemoteTask) {
        const key = JSON.stringify([ref.owner.nodeId, ref.owner.agentId, ref.owner.provider, ref.id]);
        remote.set(key, [...(remote.get(key) ?? []), ref]);
      }
    }
  }
  // Bound page enrichment; offline owners cannot turn reading saved messages into a long scan.
  const pending = [...remote.values()];
  const deadline = Date.now() + getTimeoutMs("persona.taskMetadata", 3000);
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length && Date.now() < deadline) {
      const group = pending.shift()!;
      const ref = group[0]!;
      try {
        const task = await context.readRemoteTask!(ref.owner!, ref.id);
        if (task?.id === ref.id && task.title && task.title !== ref.id) {
          for (const item of group) item.row[item.side === "source" ? "sessionTitle" : "targetSessionTitle"] = task.title;
        }
      } catch { /* One unavailable owner does not hide other task names. */ }
    }
  }));
  return rows;
}
