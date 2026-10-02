import type { GatewayDefinition } from "../types";
import type { PeerConnectionStatus } from "../../../src/shared/peerTunnelContract";
import { responseTextByByteLimit } from "../markdownPreview";

export type PersonaSourceDevice = {
  deviceId: string;
  name: string;
  online: boolean;
  supported: boolean;
  trusted: boolean;
  rabiPcVersion?: string | null;
};
export type RemotePersonaOption = { personaId: string; name: string; title?: string };
export type RemotePersonaReference = {
  schemaVersion: 1;
  roleId: string;
  file: string;
  document: string;
  personaConfig: Record<string, unknown>;
  revision: string;
  applicationGenerationId: string;
  managerInstanceId: string;
};
export type PersonaReadState = "idle" | "loading" | "ready" | "offline" | "unsupported" | "unauthorized" | "failed";

export class RemotePersonaReadError extends Error {
  constructor(readonly state: PersonaReadState, message: string) { super(message); }
}

export function remotePersonaServicePath(deviceId: string, path: string): string {
  if (!deviceId || (path !== "/meta" && !path.startsWith("/api/")) || path.startsWith("/api/rabilink/peer/")) {
    throw new Error("远端人格读取地址无效。");
  }
  return `/api/rabilink/peer/http/${encodeURIComponent(deviceId)}/persona${path}`;
}

async function readJson(path: string, signal = AbortSignal.timeout(25_000), init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(path, { ...init, signal, redirect: "error" });
  const text = await responseTextByByteLimit(response, 4 * 1024 * 1024, false, "远端人格响应过大。");
  if ([401, 403].includes(response.status)) {
    throw new RemotePersonaReadError("unauthorized", "RabiLink 鉴权失败，无法读取远端人格。请检查 RabiLink 的连接和登录状态。");
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid JSON envelope.");
  }
  catch {
    const unsupported = response.status === 404 || response.headers.get("content-type")?.includes("text/html") || /^\s*(?:<!doctype\s+html|<html)/i.test(text);
    throw new RemotePersonaReadError(unsupported ? "unsupported" : "failed", `远端人格返回了无效响应（HTTP ${response.status}）。`);
  }
  if (!response.ok || ("code" in body && body.code !== 0)) {
    const message = String(body.message || body.error || `HTTP ${response.status}`);
    const knownMissingPersona = ["PERSONA_NOT_FOUND", "PERSONA_FILE_NOT_FOUND"].includes(String(body.error));
    const state = response.status === 426 || body.error === "REMOTE_PERSONA_UPGRADE_REQUIRED" || (response.status === 404 && !knownMissingPersona)
      ? "unsupported" : body.error === "REMOTE_PERSONA_UNAVAILABLE" ? "offline" : "failed";
    throw new RemotePersonaReadError(state, message);
  }
  return body;
}

type RemoteManagerIdentity = { applicationGenerationId: string; managerInstanceId: string };
async function readPersonaManagerIdentity(path: string, requireReady: boolean, signal?: AbortSignal): Promise<RemoteManagerIdentity> {
  const meta = await readJson(path, signal);
  const applicationGenerationId = meta.applicationGenerationId;
  const managerInstanceId = meta.managerInstanceId;
  if (typeof applicationGenerationId !== "string" || !applicationGenerationId.trim()
    || typeof managerInstanceId !== "string" || !managerInstanceId.trim()) throw new Error("Manager 未提供完整身份。");
  const health = meta.health as { live?: boolean; requiredReady?: boolean; state?: string } | undefined;
  if (requireReady && (!health || health.live !== true || health.requiredReady !== true
    || !["healthy", "degraded"].includes(health.state || ""))) throw new Error("Manager 尚未就绪。");
  return { applicationGenerationId, managerInstanceId };
}

export async function readRemotePersonaMeta(deviceId: string, requireReady: boolean, signal?: AbortSignal): Promise<RemoteManagerIdentity> {
  return readPersonaManagerIdentity(remotePersonaServicePath(deviceId, "/meta"), requireReady, signal);
}

export function sameRemotePersonaManager(left: RemoteManagerIdentity, right: RemoteManagerIdentity): boolean {
  return left.applicationGenerationId === right.applicationGenerationId && left.managerInstanceId === right.managerInstanceId;
}

export async function bootstrapRemotePersonaService(deviceId: string, signal = AbortSignal.timeout(25_000)): Promise<void> {
  if (!deviceId) throw new Error("远端人格来源 PC 无效。");
  const before = await readPersonaManagerIdentity("/meta", true, signal);
  const body = await readJson("/api/rabilink/peer/persona/bootstrap", signal, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId })
  });
  if (body.code !== 0 || (body.data as { deviceId?: unknown } | undefined)?.deviceId !== deviceId) {
    throw new Error("RabiLink 自动连接返回的来源 PC 不一致。");
  }
  const after = await readPersonaManagerIdentity("/meta", false, signal);
  if (!sameRemotePersonaManager(before, after)) throw new Error("本机 Manager 身份已变化，请重新连接来源 PC。");
}

export const remotePersonaClient = {
  async devices(): Promise<PersonaSourceDevice[]> {
    const signal = AbortSignal.timeout(25_000);
    const [discovery, servers] = await Promise.all([
      readJson("/api/rabilink/peer/list?deviceKind=pc", signal),
      readJson("/api/rabilink/peer/servers", signal)
    ]);
    const peers = discovery.peers as Array<{ id: string; name: string; online: boolean; rabiPcVersion?: string | null }>;
    const connections = ((servers.data as { peers?: PeerConnectionStatus[] } | undefined)?.peers || servers.peers) as Array<PeerConnectionStatus & { personaSupported?: boolean }>;
    if (!Array.isArray(peers) || !Array.isArray(connections)) throw new Error("远端 PC 目录格式无效。");
    return peers.map(peer => {
      const connection = connections.find(item => item.deviceId === peer.id);
      return {
        deviceId: peer.id, name: peer.name || peer.id,
        online: peer.online === true || connection?.online === true,
        supported: connection?.personaSupported === true,
        trusted: connection?.trusted === true,
        rabiPcVersion: typeof peer.rabiPcVersion === "string" ? peer.rabiPcVersion : null
      };
    });
  },
  async personas(deviceId: string): Promise<RemotePersonaOption[]> {
    const signal = AbortSignal.timeout(25_000);
    await bootstrapRemotePersonaService(deviceId, signal);
    const before = await readRemotePersonaMeta(deviceId, true, signal);
    const body = await readJson(remotePersonaServicePath(deviceId, "/api/personas"), signal);
    if (!Array.isArray(body.personas)) throw new Error("远端人格目录格式无效。");
    const personas = body.personas.map((value: unknown) => {
      if (!value || typeof value !== "object") throw new Error("远端人格目录格式无效。");
      const persona = value as RemotePersonaOption;
      if (typeof persona.personaId !== "string" || !persona.personaId) throw new Error("远端人格 ID 无效。");
      return { personaId: persona.personaId, name: persona.name || persona.personaId, title: persona.title };
    });
    const after = await readRemotePersonaMeta(deviceId, false, signal);
    if (!sameRemotePersonaManager(before, after)) throw new Error("远端 Manager 身份已变化，请重新读取人格目录。");
    return personas;
  },
  async reference(deviceId: string, roleId: string, file: string): Promise<RemotePersonaReference> {
    const signal = AbortSignal.timeout(25_000);
    await bootstrapRemotePersonaService(deviceId, signal);
    const before = await readRemotePersonaMeta(deviceId, true, signal);
    const query = new URLSearchParams({ file });
    const body = await readJson(remotePersonaServicePath(deviceId, `/api/roles/${encodeURIComponent(roleId)}/persona-reference?${query}`), signal);
    const data = body.data as RemotePersonaReference | undefined;
    if (!data || data.schemaVersion !== 1 || data.roleId !== roleId || data.file !== file
      || typeof data.document !== "string" || !data.personaConfig || typeof data.personaConfig !== "object" || Array.isArray(data.personaConfig)
      || !data.applicationGenerationId || !data.managerInstanceId || !/^[a-f0-9]{64}$/.test(data.revision || "")) throw new Error("远端人格身份或配置响应无效。");
    if (new TextEncoder().encode(data.document).byteLength > 2 * 1024 * 1024) throw new Error("远端人格正文超过 2 MiB。");
    const after = await readRemotePersonaMeta(deviceId, false, signal);
    if (!sameRemotePersonaManager(before, data) || !sameRemotePersonaManager(before, after)) {
      throw new Error("远端 Manager 身份已变化，请重新读取人格。");
    }
    return data;
  }
};

/** Rebuildable remote view state; never writes a remote configuration into a local route. */
export class RemotePersonaReferenceBrowser {
  devices: PersonaSourceDevice[] = [];
  devicesLoading = false;
  devicesError = "";
  sourceDeviceId = "";
  personas: RemotePersonaOption[] = [];
  catalogState: PersonaReadState = "idle";
  catalogError = "";
  reference: RemotePersonaReference | null = null;
  referenceState: PersonaReadState = "idle";
  referenceError = "";
  private devicesEpoch = 0;
  private catalogEpoch = 0;
  private referenceEpoch = 0;
  constructor(private readonly client = remotePersonaClient) {}

  async refreshDevices(): Promise<void> {
    const epoch = ++this.devicesEpoch;
    this.devicesLoading = true;
    this.devicesError = "";
    try {
      const devices = await this.client.devices();
      if (epoch === this.devicesEpoch) this.devices = devices;
    } catch (error) {
      if (epoch === this.devicesEpoch) this.devicesError = error instanceof Error ? error.message : String(error);
    } finally { if (epoch === this.devicesEpoch) this.devicesLoading = false; }
  }

  async selectSource(deviceId: string): Promise<void> {
    const epoch = ++this.catalogEpoch;
    ++this.referenceEpoch;
    this.sourceDeviceId = deviceId;
    this.personas = [];
    this.reference = null;
    this.catalogError = this.referenceError = "";
    this.referenceState = "idle";
    this.catalogState = deviceId ? "loading" : "idle";
    if (!deviceId) return;
    const device = this.devices.find(item => item.deviceId === deviceId);
    if (device && (!device.online || !device.supported)) {
      this.catalogState = !device.online ? "offline" : "unsupported";
      return;
    }
    try {
      const personas = await this.client.personas(deviceId);
      if (epoch === this.catalogEpoch) { this.personas = personas; this.catalogState = "ready"; }
    } catch (error) {
      if (epoch === this.catalogEpoch) {
        this.catalogState = error instanceof RemotePersonaReadError ? error.state : "failed";
        this.catalogError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async loadReference(deviceId: string, roleId: string, file: string): Promise<void> {
    if (deviceId !== this.sourceDeviceId) return;
    const epoch = ++this.referenceEpoch;
    this.reference = null;
    this.referenceError = "";
    this.referenceState = deviceId && roleId ? "loading" : "idle";
    if (!deviceId || !roleId) return;
    try {
      const reference = await this.client.reference(deviceId, roleId, file);
      if (epoch === this.referenceEpoch && deviceId === this.sourceDeviceId) {
        this.reference = reference;
        this.referenceState = "ready";
      }
    } catch (error) {
      if (epoch === this.referenceEpoch && deviceId === this.sourceDeviceId) {
        this.referenceState = error instanceof RemotePersonaReadError ? error.state : "failed";
        this.referenceError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  invalidate(): void { ++this.devicesEpoch; ++this.catalogEpoch; ++this.referenceEpoch; }
}

export function personaReferenceIdentity(gateway: Pick<GatewayDefinition, "agentRoleId" | "agentRoleDeviceId" | "agentRoleFile">): string {
  return JSON.stringify([gateway.agentRoleDeviceId || "", gateway.agentRoleId || "", gateway.agentRoleFile || "persona.md"]);
}
