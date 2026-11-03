import type { AgentInstance } from "@shared/agentInstance";
import type { AgentAdapterManifest } from "@shared/agentAdapterCapabilities";
import { peerManagerPath } from "./peerManagerTarget";
type ConnectedPeer = { id: string; online: boolean; deviceKind: string; name?: string };

/** A failed PC remains local to that catalog; other connected hosts stay selectable. */
export async function readConnectedAgentInstances(request: typeof fetch, headers: Record<string, string>): Promise<{ instances: AgentInstance[]; errors: string[] }> {
  const read = async (pathname: string) => {
    const response = await request(pathname, { cache: "no-store", headers });
    const body = await response.json();
    if (!response.ok || body.code === -1) throw new Error(body.message || "读取已连接主机失败。");
    return body;
  };
  const [meta, directory] = await Promise.all([read("/meta"), read("/api/rabilink/peer/list")]);
  const targets = ((directory.peers || []) as ConnectedPeer[]).filter(peer => peer.deviceKind === "pc" && peer.online && peer.id !== meta.rabiLinkRelay?.deviceId);
  const results = await Promise.allSettled(targets.map(async peer => {
    const [instances, adapters] = await Promise.allSettled([
      read(peerManagerPath(peer.id, "/api/lan-agent/instances")), read(peerManagerPath(peer.id, "/api/agent-adapters/catalog"))
    ]);
    if (instances.status === "rejected") throw instances.reason;
    const manifests: AgentAdapterManifest[] = adapters.status === "fulfilled" ? adapters.value.data?.adapters || [] : [];
    return { instances: ((instances.value.instances || []) as AgentInstance[]).filter(instance => instance.local).map(instance => {
      const aliases = manifests.filter(adapter => adapter.capabilities.managedTasks?.agentThreads && adapter.type !== "deviceAgent"
        && !instance.agents.some(agent => (agent.provider === "codex-desktop" ? "codex" : agent.provider) === adapter.type))
        .map(adapter => ({ agentId: `local:${adapter.type}`, name: adapter.label, provider: adapter.type, enabled: true }));
      return { ...instance, agents: [...instance.agents, ...aliases], local: false, ownerDeviceId: peer.id, name: peer.name || instance.name || peer.id };
    }), errors: adapters.status === "rejected" ? [`${peer.id}: ${String(adapters.reason)}`] : [] };
  }));
  return { instances: results.flatMap(result => result.status === "fulfilled" ? result.value.instances : []),
    errors: results.flatMap((result, index) => result.status === "fulfilled" ? result.value.errors : [`${targets[index].id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]) };
}
