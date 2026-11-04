import type { AgentInstance } from "@shared/agentInstance";
import type { AgentAdapterManifest } from "@shared/agentAdapterCapabilities";
import { peerManagerPath } from "./peerManagerTarget";
import { deviceAgentInstanceFromCatalog } from "./deviceAgentCatalog";

type ConnectedPeer = { id: string; online: boolean; deviceKind: string; name?: string };
export type AgentDirectoryDiagnostic = Readonly<{
  source: "access" | "local-instances" | "device-agents" | "peer-directory" | "peer-instances" | "peer-adapters";
  ownerDeviceId?: string;
  message: string;
}>;
export type AgentInstanceDirectory = Readonly<{ instances: AgentInstance[]; diagnostics: AgentDirectoryDiagnostic[] }>;
type DirectoryTarget = Readonly<{ provider: string; ownerDeviceId?: string }>;

export function agentDirectoryFailure(source: AgentDirectoryDiagnostic["source"], error: unknown, ownerDeviceId?: string): AgentDirectoryDiagnostic {
  return { source, ...(ownerDeviceId ? { ownerDeviceId } : {}), message: error instanceof Error ? error.message : String(error) };
}

/** Directory diagnostics follow the source owner, never another Agent's card. */
export function agentDirectoryDiagnosticsForTarget(diagnostics: readonly AgentDirectoryDiagnostic[], target: DirectoryTarget): readonly AgentDirectoryDiagnostic[] {
  return diagnostics.filter(item => {
    if (item.source === "access") return true;
    if (item.source === "device-agents") return target.provider === "deviceAgent" && !target.ownerDeviceId;
    if (item.source === "local-instances") return target.provider !== "deviceAgent" && !target.ownerDeviceId;
    if (item.source === "peer-directory") return !!target.ownerDeviceId;
    return !!item.ownerDeviceId && item.ownerDeviceId === target.ownerDeviceId;
  });
}

export function unassignedAgentDirectoryDiagnostics(diagnostics: readonly AgentDirectoryDiagnostic[], targets: readonly DirectoryTarget[]): readonly AgentDirectoryDiagnostic[] {
  return diagnostics.filter(item => !targets.some(target => agentDirectoryDiagnosticsForTarget([item], target).length));
}

function directoryReader(request: typeof fetch, headers: Record<string, string>, signal?: AbortSignal) {
  return async (pathname: string) => {
    const response = await request(pathname, { cache: "no-store", headers, signal });
    const body = await response.json();
    if (!response.ok || body.code === -1) throw new Error(body.message || "读取已连接主机失败。");
    return body;
  };
}

/** A failed PC remains local to that catalog; other connected hosts stay selectable. */
export async function readConnectedAgentInstances(request: typeof fetch, headers: Record<string, string>, signal?: AbortSignal): Promise<AgentInstanceDirectory> {
  const read = directoryReader(request, headers, signal);
  const directory = await Promise.allSettled([read("/meta"), read("/api/rabilink/peer/list")]);
  const diagnostics: AgentDirectoryDiagnostic[] = directory.flatMap(result => result.status === "rejected" ? [agentDirectoryFailure("peer-directory", result.reason)] : []);
  const [meta, peers] = directory;
  if (meta.status !== "fulfilled" || peers.status !== "fulfilled") return { instances: [], diagnostics };
  const targets = ((peers.value.peers || []) as ConnectedPeer[]).filter(peer => peer.deviceKind === "pc" && peer.online && peer.id !== meta.value.rabiLinkRelay?.deviceId);
  const results = await Promise.allSettled(targets.map(async peer => {
    const [instances, adapters] = await Promise.allSettled([
      read(peerManagerPath(peer.id, "/api/lan-agent/instances")), read(peerManagerPath(peer.id, "/api/agent-adapters/catalog"))
    ]);
    const diagnostics = [
      ...(instances.status === "rejected" ? [agentDirectoryFailure("peer-instances", instances.reason, peer.id)] : []),
      ...(adapters.status === "rejected" ? [agentDirectoryFailure("peer-adapters", adapters.reason, peer.id)] : [])
    ];
    if (instances.status !== "fulfilled") return { instances: [], diagnostics };
    const manifests: AgentAdapterManifest[] = adapters.status === "fulfilled" ? adapters.value.data?.adapters || [] : [];
    return { instances: ((instances.value.instances || []) as AgentInstance[]).filter(instance => instance.local).map(instance => {
      const aliases = manifests.filter(adapter => adapter.capabilities.managedTasks?.agentThreads && adapter.type !== "deviceAgent"
        && !instance.agents.some(agent => (agent.provider === "codex-desktop" ? "codex" : agent.provider) === adapter.type))
        .map(adapter => ({ agentId: `local:${adapter.type}`, name: adapter.label, provider: adapter.type, enabled: true }));
      return { ...instance, agents: [...instance.agents, ...aliases], local: false, ownerDeviceId: peer.id, name: peer.name || instance.name || peer.id };
    }), diagnostics };
  }));
  return { instances: results.flatMap(result => result.status === "fulfilled" ? result.value.instances : []),
    diagnostics: [...diagnostics, ...results.flatMap((result, index) => result.status === "fulfilled" ? result.value.diagnostics : [agentDirectoryFailure("peer-instances", result.reason, targets[index].id)])] };
}

/** Read-only discovery preserves each successful source when another source fails. */
export async function readAgentInstanceDirectory(request: typeof fetch, headers: Record<string, string>, signal?: AbortSignal): Promise<AgentInstanceDirectory> {
  const read = directoryReader(request, headers, signal);
  const results = await Promise.allSettled([
    read("/api/lan-agent/instances").then(body => {
      if (body.code !== 0) throw new Error(body.message || "读取电脑 Agent 实例失败");
      return (body.instances || []) as AgentInstance[];
    }),
    read("/api/device-agents").then(body => {
      if (body.code !== 0) throw new Error(body.message || "设备 Agent 未配置：请在设备设置中绑定角色和所属电脑后刷新。");
      const instance = deviceAgentInstanceFromCatalog(body.data);
      return instance ? [instance] : [];
    }),
    readConnectedAgentInstances(request, headers, signal)
  ]);
  const [local, device, peers] = results;
  return {
    instances: [...(local.status === "fulfilled" ? local.value : []), ...(device.status === "fulfilled" ? device.value : []), ...(peers.status === "fulfilled" ? peers.value.instances : [])],
    diagnostics: [
      ...(local.status === "rejected" ? [agentDirectoryFailure("local-instances", local.reason)] : []),
      ...(device.status === "rejected" ? [agentDirectoryFailure("device-agents", device.reason)] : []),
      ...(peers.status === "fulfilled" ? peers.value.diagnostics : [agentDirectoryFailure("peer-directory", peers.reason)])
    ]
  };
}
