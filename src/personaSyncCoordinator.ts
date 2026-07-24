import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  PERSONA_SYNC_DELETED_HASH,
  type PersonaSyncFile,
  type PersonaSyncConflictResolution,
  type PersonaSyncManifest,
  type PersonaSyncMergeResult,
  type PersonaSyncService
} from "./personaSync.js";
import {
  listPersonaVoiceIdentities,
  type PersonaVoiceIdentityConflictField
} from "./personaVoiceIdentities.js";
import { atomicWriteFileSync, withFileLockSync } from "./shared/filePersistence.js";

export type PersonaSyncPeer = {
  id: string;
  guid?: string;
  name: string;
  online: boolean;
  capabilities: string[];
  peerUrls: string[];
};

export type PersonaSyncRelayConfig = {
  url: string;
  token: string;
  deviceId: string;
  deviceGuid: string;
};

export type PersonaSyncResult = {
  peer: PersonaSyncPeer;
  baseUrl: string;
  transport: "lan" | "relay";
  files: Array<PersonaSyncMergeResult & { direction: "pull" | "push" | "converged" }>;
  fileConflicts: number;
  semanticConflicts: PersonaSyncSemanticConflict[];
  conflicts: number;
};

export type PersonaSyncSemanticConflict = {
  kind: "persona_voice_identity";
  roleId: string;
  path: "voice/voice-identities.jsonl";
  identityKey: string;
  sourceHostId: string;
  voiceprintId: string;
  fields: PersonaVoiceIdentityConflictField[];
  candidateEventIds: string[];
};

export type PersonaSyncResolutionPublishResult = {
  status: "published" | "not_published";
  peerId?: string;
  transport?: "lan" | "relay";
  message?: string;
  merge?: PersonaSyncMergeResult;
};

type SyncState = { schemaVersion: 1; peerId: string; hashes: Record<string, string>; updatedAt: string };

function safePeerId(value: string): string {
  return value.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "peer";
}

function fileKey(file: Pick<PersonaSyncFile, "roleId" | "path">): string {
  return `${file.roleId}/${file.path}`;
}

function applicationScope(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class PersonaSyncCoordinator {
  private readonly syncFlights = new Map<string, Promise<PersonaSyncResult>>();

  constructor(
    readonly service: PersonaSyncService,
    readonly stateRoot: string,
    readonly relayConfig: () => PersonaSyncRelayConfig
  ) {}

  async peers(): Promise<PersonaSyncPeer[]> {
    const relay = this.relayConfig();
    if (!relay.url.trim() || !relay.token.trim()) throw new Error("RabiLink Relay is not configured for persona peer discovery.");
    const params = new URLSearchParams({ deviceId: relay.deviceId, deviceGuid: relay.deviceGuid });
    const response = await fetchWithTimeout(`${relay.url.replace(/\/+$/, "")}/api/rabilink/peers?${params}`, {
      headers: { "x-rabilink-token": relay.token }
    }, 5_000);
    const body = await response.json().catch(() => ({})) as { peers?: PersonaSyncPeer[]; message?: string };
    if (!response.ok) throw new Error(body.message || `RabiLink peer discovery failed: HTTP ${response.status}`);
    return Array.isArray(body.peers) ? body.peers : [];
  }

  async sync(peerId: string, roleId?: string): Promise<PersonaSyncResult> {
    const key = `${safePeerId(peerId)}:${roleId || "*"}`;
    const existing = this.syncFlights.get(key);
    if (existing) return existing;
    const flight = this.runSync(peerId, roleId).finally(() => {
      if (this.syncFlights.get(key) === flight) this.syncFlights.delete(key);
    });
    this.syncFlights.set(key, flight);
    return flight;
  }

  async publishConflictResolution(
    resolution: PersonaSyncConflictResolution
  ): Promise<PersonaSyncResolutionPublishResult> {
    const peerId = String(resolution.peerId || "").trim();
    if (!peerId) {
      return { status: "not_published", message: "Conflict evidence does not identify the source peer." };
    }
    try {
      const peers = await this.peers();
      const peer = peers.find(item => item.id === peerId || item.guid === peerId);
      if (!peer) return { status: "not_published", peerId, message: "The source peer is not currently discoverable." };
      if (!peer.capabilities.includes("persona-sync")) {
        return { status: "not_published", peerId, message: `Peer ${peer.name} does not advertise persona-sync.` };
      }
      const relay = this.relayConfig();
      const connection = await this.connect(peer, relay, resolution.roleId);
      const key = `${resolution.roleId}/${resolution.path}`;
      const remote = connection.manifest.roles
        .flatMap(role => role.files)
        .find(file => fileKey(file) === key);
      const remoteMatchesEvidence = resolution.remoteDeleted
        ? !remote
        : remote?.sha256 === resolution.remoteHash;
      if (!remoteMatchesEvidence) {
        return {
          status: "not_published",
          peerId,
          transport: connection.transport,
          message: "The peer changed after this conflict evidence was captured; synchronize again to create current evidence."
        };
      }
      const local = (await this.service.manifest(resolution.roleId)).roles
        .flatMap(role => role.files)
        .find(file => fileKey(file) === key);
      const localMatchesResolution = resolution.resultHash
        ? local?.sha256 === resolution.resultHash
        : !local;
      if (!localMatchesResolution) {
        return {
          status: "not_published",
          peerId,
          transport: connection.transport,
          message: "The local file changed after conflict resolution; synchronize again instead of publishing stale content."
        };
      }

      let merge: PersonaSyncMergeResult | undefined;
      if (local && (!remote || local.sha256 !== remote.sha256)) {
        const content = this.service.readFile(local.roleId, local.path).content;
        merge = await this.remoteMerge(connection, relay, {
          roleId: local.roleId,
          path: local.path,
          contentBase64: content.toString("base64"),
          remoteHash: local.sha256,
          baseHash: resolution.remoteDeleted ? PERSONA_SYNC_DELETED_HASH : resolution.remoteHash,
          peerId: relay.deviceId
        });
      } else if (!local && remote) {
        merge = await this.remoteMerge(connection, relay, {
          roleId: resolution.roleId,
          path: resolution.path,
          deleted: true,
          remoteHash: PERSONA_SYNC_DELETED_HASH,
          baseHash: resolution.remoteHash,
          peerId: relay.deviceId
        });
      }
      if (merge?.status === "conflict") {
        return {
          status: "not_published",
          peerId,
          transport: connection.transport,
          message: "The peer refused the resolved version because its current file no longer matches the evidence.",
          merge
        };
      }

      const statePeerId = peer.guid || peer.id;
      const state = this.readState(statePeerId, relay.token);
      if (local) state.hashes[key] = local.sha256;
      else if (resolution.baseHash) state.hashes[key] = resolution.baseHash;
      else if (!resolution.remoteDeleted) state.hashes[key] = resolution.remoteHash;
      this.writeState(state, relay.token);
      return { status: "published", peerId, transport: connection.transport, merge };
    } catch (error) {
      return {
        status: "not_published",
        peerId,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async runSync(peerId: string, roleId?: string): Promise<PersonaSyncResult> {
    const peers = await this.peers();
    const peer = peers.find(item => item.id === peerId || item.guid === peerId);
    if (!peer) throw new Error(`Persona sync peer was not found: ${peerId}`);
    if (!peer.capabilities.includes("persona-sync")) throw new Error(`Peer ${peer.name} does not advertise persona-sync.`);
    const relay = this.relayConfig();
    const connection = await this.connect(peer, relay, roleId);
    const localManifest = await this.service.manifest(roleId);
    const localFiles = new Map(localManifest.roles.flatMap(role => role.files).map(file => [fileKey(file), file]));
    const remoteFiles = new Map(connection.manifest.roles.flatMap(role => role.files).map(file => [fileKey(file), file]));
    const statePeerId = peer.guid || peer.id;
    const state = this.readState(statePeerId, relay.token);
    const results: PersonaSyncResult["files"] = [];
    for (const key of [...new Set([...localFiles.keys(), ...remoteFiles.keys()])].sort()) {
      let local = localFiles.get(key);
      const remote = remoteFiles.get(key);
      if (local && remote && local.sha256 === remote.sha256) {
        state.hashes[key] = local.sha256;
        results.push({
          status: "unchanged",
          roleId: local.roleId,
          path: local.path,
          localHash: local.sha256,
          remoteHash: remote.sha256,
          resultHash: local.sha256,
          direction: "converged"
        });
        continue;
      }
      if (!remote && local) {
        const baseHash = state.hashes[key];
        if (baseHash && local.mergeStrategy === "three-way-file") {
          const pulledDeletion = this.service.merge({
            roleId: local.roleId,
            path: local.path,
            deleted: true,
            remoteHash: PERSONA_SYNC_DELETED_HASH,
            baseHash,
            peerId: peer.id
          });
          results.push({ ...pulledDeletion, direction: "pull" });
          continue;
        }
        const localContent = this.service.readFile(local.roleId, local.path).content;
        const pushed = await this.remoteMerge(connection, relay, {
          roleId: local.roleId,
          path: local.path,
          contentBase64: localContent.toString("base64"),
          remoteHash: local.sha256,
          peerId: relay.deviceId
        });
        results.push({ ...pushed, direction: "push" });
        if (pushed.status !== "conflict" && pushed.resultHash) state.hashes[key] = pushed.resultHash;
        continue;
      }
      if (!remote) continue;
      if (!local
        && remote.mergeStrategy === "three-way-file"
        && state.hashes[key]
        && remote.sha256 === state.hashes[key]) {
        const pushedDeletion = await this.remoteMerge(connection, relay, {
          roleId: remote.roleId,
          path: remote.path,
          deleted: true,
          remoteHash: PERSONA_SYNC_DELETED_HASH,
          baseHash: remote.sha256,
          peerId: relay.deviceId
        });
        results.push({ ...pushedDeletion, direction: "push" });
        continue;
      }
      const remoteContent = await this.remoteFile(connection, relay, remote);
      const pulled = this.service.merge({
        roleId: remote.roleId,
        path: remote.path,
        contentBase64: remoteContent.toString("base64"),
        remoteHash: remote.sha256,
        baseHash: state.hashes[key],
        peerId: peer.id
      });
      results.push({ ...pulled, direction: "pull" });
      if (pulled.status === "conflict") continue;
      local = (await this.service.manifest(remote.roleId)).roles[0]?.files.find(file => file.path === remote.path);
      if (!local) continue;
      if (local.sha256 !== remote.sha256) {
        const content = this.service.readFile(local.roleId, local.path).content;
        const pushed = await this.remoteMerge(connection, relay, {
          roleId: local.roleId,
          path: local.path,
          contentBase64: content.toString("base64"),
          remoteHash: local.sha256,
          baseHash: remote.sha256,
          peerId: relay.deviceId
        });
        results.push({ ...pushed, direction: "push" });
        if (pushed.status === "conflict") continue;
      }
      state.hashes[key] = local.sha256;
    }
    this.writeState(state, relay.token);
    const fileConflicts = results.filter(item => item.status === "conflict").length;
    const semanticConflicts = await this.semanticConflicts(roleId);
    return {
      peer,
      baseUrl: connection.baseUrl,
      transport: connection.transport,
      files: results,
      fileConflicts,
      semanticConflicts,
      conflicts: fileConflicts + semanticConflicts.length
    };
  }

  private async semanticConflicts(roleId?: string): Promise<PersonaSyncSemanticConflict[]> {
    const manifest = await this.service.manifest(roleId);
    return manifest.roles.flatMap(role => {
      const roleDir = path.join(this.service.rolesRoot(), role.roleId);
      return listPersonaVoiceIdentities(roleDir).flatMap(identity => identity.conflicted ? [{
        kind: "persona_voice_identity" as const,
        roleId: role.roleId,
        path: "voice/voice-identities.jsonl" as const,
        identityKey: identity.identityKey,
        sourceHostId: identity.sourceHostId,
        voiceprintId: identity.voiceprintId,
        fields: identity.conflictFields ?? [],
        candidateEventIds: identity.conflictCandidates?.map(candidate => candidate.eventId).sort() ?? []
      }] : []);
    });
  }

  private async connect(
    peer: PersonaSyncPeer,
    relay: PersonaSyncRelayConfig,
    roleId?: string
  ): Promise<{ baseUrl: string; transport: "lan" | "relay"; peerId: string; manifest: PersonaSyncManifest }> {
    let lastError: unknown;
    for (const baseUrl of peer.peerUrls) {
      try {
        const params = roleId ? `?roleId=${encodeURIComponent(roleId)}` : "";
        const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}/api/persona-sync/manifest${params}`, {
          headers: { "x-rabilink-token": relay.token }
        }, 3_000);
        const body = await response.json() as { data?: PersonaSyncManifest; message?: string };
        if (!response.ok || !body.data) throw new Error(body.message || `HTTP ${response.status}`);
        return { baseUrl: baseUrl.replace(/\/+$/, ""), transport: "lan", peerId: peer.id, manifest: body.data };
      } catch (error) {
        lastError = error;
      }
    }
    try {
      const params = roleId ? `?roleId=${encodeURIComponent(roleId)}` : "";
      const response = await this.relayProxy(relay, peer.id, "GET", `/api/persona-sync/manifest${params}`);
      const body = await response.json() as { data?: PersonaSyncManifest; message?: string };
      if (!response.ok || !body.data) throw new Error(body.message || `HTTP ${response.status}`);
      return {
        baseUrl: relay.url.replace(/\/+$/, ""),
        transport: "relay",
        peerId: peer.id,
        manifest: body.data
      };
    } catch (relayError) {
      const directMessage = lastError instanceof Error ? lastError.message : "no direct endpoint";
      const relayMessage = relayError instanceof Error ? relayError.message : String(relayError);
      throw new Error(`Persona sync could not reach ${peer.name} directly or through Relay: direct=${directMessage}; relay=${relayMessage}`);
    }
  }

  private async remoteFile(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string },
    relay: PersonaSyncRelayConfig,
    file: PersonaSyncFile
  ): Promise<Buffer> {
    const remotePath = `/api/persona-sync/files/${encodeURIComponent(file.roleId)}/${encodeURIComponent(file.path)}`;
    const response = connection.transport === "lan"
      ? await fetchWithTimeout(`${connection.baseUrl}${remotePath}`, { headers: { "x-rabilink-token": relay.token } })
      : await this.relayProxy(relay, connection.peerId, "GET", remotePath, undefined, "application/octet-stream");
    if (!response.ok) throw new Error(`Failed to read ${file.roleId}/${file.path} from peer: HTTP ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    const hash = response.headers.get("x-rabi-sha256") || "";
    if (hash && hash !== file.sha256) throw new Error(`Peer file changed during sync: ${file.roleId}/${file.path}`);
    return content;
  }

  private async remoteMerge(
    connection: { baseUrl: string; transport: "lan" | "relay"; peerId: string },
    relay: PersonaSyncRelayConfig,
    command: Record<string, unknown>
  ): Promise<PersonaSyncMergeResult> {
    const bodyBuffer = Buffer.from(JSON.stringify(command), "utf8");
    const response = connection.transport === "lan"
      ? await fetchWithTimeout(`${connection.baseUrl}/api/persona-sync/merge`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
          body: bodyBuffer
        })
      : await this.relayProxy(relay, connection.peerId, "POST", "/api/persona-sync/merge", bodyBuffer);
    const body = await response.json().catch(() => ({})) as { data?: PersonaSyncMergeResult; message?: string };
    if (!body.data) throw new Error(body.message || `Peer merge failed: HTTP ${response.status}`);
    return body.data;
  }

  private relayProxy(
    relay: PersonaSyncRelayConfig,
    targetDeviceId: string,
    method: "GET" | "POST",
    remotePath: string,
    body?: Buffer,
    accept = "application/json"
  ): Promise<Response> {
    return fetchWithTimeout(`${relay.url.replace(/\/+$/, "")}/api/rabilink/persona-sync/proxy`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": relay.token },
      body: JSON.stringify({
        targetDeviceId,
        method,
        path: remotePath,
        accept,
        bodyBase64: body?.toString("base64") || ""
      })
    }, 70_000);
  }

  private statePath(peerId: string, applicationToken: string): string {
    return path.join(this.stateRoot, "peers", applicationScope(applicationToken), `${safePeerId(peerId)}.json`);
  }

  private readState(peerId: string, applicationToken: string): SyncState {
    const filePath = this.statePath(peerId, applicationToken);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SyncState>;
      return {
        schemaVersion: 1,
        peerId,
        hashes: parsed.hashes && typeof parsed.hashes === "object" ? parsed.hashes : {},
        updatedAt: String(parsed.updatedAt || new Date().toISOString())
      };
    } catch {
      return { schemaVersion: 1, peerId, hashes: {}, updatedAt: new Date().toISOString() };
    }
  }

  private writeState(state: SyncState, applicationToken: string): void {
    const filePath = this.statePath(state.peerId, applicationToken);
    withFileLockSync(`${filePath}.lock`, () => {
      const latest = this.readState(state.peerId, applicationToken);
      atomicWriteFileSync(filePath, `${JSON.stringify({
        schemaVersion: 1,
        peerId: state.peerId,
        hashes: { ...latest.hashes, ...state.hashes },
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`);
    });
  }
}
