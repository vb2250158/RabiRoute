export type PersonaSyncPeer = {
  id: string;
  guid?: string;
  name: string;
  online: boolean;
  capabilities: string[];
  peerUrls: string[];
};

export type PersonaSyncIndexStatus = {
  state: "idle" | "initializing" | "ready" | "fallback" | "failed" | "stopped";
  watchMode: "recursive" | "query_reconcile" | "disabled";
  generation: number;
  roles: number;
  files: number;
  totalHashedFiles: number;
  error?: string;
};

export type PersonaSyncAutoStatus = {
  state: "stopped" | "waiting_relay" | "waiting_peer" | "idle" | "scheduled" | "syncing" | "attention" | "error";
  relayOnline: boolean;
  pending: boolean;
  pendingFullSync: boolean;
  pendingRoleCount: number;
  retryAttempt: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastOutcome?: {
    peersSeen: number;
    peersSynced: number;
    conflicts: number;
    failures: number;
    lan: number;
    relay: number;
  };
};

export type PersonaSyncFileResult = {
  status: "created" | "fast_forwarded" | "kept_local" | "merged" | "unchanged" | "conflict";
  roleId: string;
  path: string;
  direction: "pull" | "push" | "converged";
  remoteDeleted?: boolean;
};

export type PersonaSyncSemanticConflict =
  | {
      kind: "persona_voice_identity";
      roleId: string;
      path: "voice/voice-identities.jsonl";
      identityKey: string;
      sourceHostId: string;
      voiceprintId: string;
      fields: string[];
      candidateEventIds: string[];
    }
  | {
      kind: "identity_relation";
      roleId: string;
      path: "identity-relations/events.jsonl";
      recordKind: "endpoint_account" | "participant" | "relation_card";
      recordId: string;
      candidateEventIds: string[];
    };

export type PersonaSyncResult = {
  peer: PersonaSyncPeer;
  transport: "lan" | "relay";
  files: PersonaSyncFileResult[];
  fileConflicts: number;
  semanticConflicts: PersonaSyncSemanticConflict[];
  conflicts: number;
};

export type PersonaSyncPreviewOperation =
  | "unchanged"
  | "pull_create"
  | "pull_update"
  | "pull_delete"
  | "push_create"
  | "push_update"
  | "push_delete"
  | "auto_merge"
  | "conflict";

export type PersonaSyncPreviewFile = {
  roleId: string;
  path: string;
  operation: PersonaSyncPreviewOperation;
  direction: "pull" | "push" | "merge" | "conflict" | "converged";
  mergeStrategy: "jsonl-union" | "three-way-file";
  localHash?: string;
  remoteHash?: string;
  baseHash?: string;
  localSize?: number;
  remoteSize?: number;
};

export type PersonaSyncPreview = {
  peer: PersonaSyncPeer;
  transport: "lan" | "relay";
  files: PersonaSyncPreviewFile[];
  changedFiles: number;
  conflicts: number;
};

export type PersonaSyncConflict = {
  conflictId: string;
  roleId: string;
  path: string;
  size: number;
  createdAt: string;
  localHash?: string;
  remoteHash: string;
  remoteDeleted?: boolean;
  peerId?: string;
  baseHash?: string;
};

export type PersonaSyncConflictScan = {
  state: "ready" | "building";
  partial: boolean;
  retryAfterMs?: number;
  message?: string;
};

export type PersonaSyncConflictResolution = {
  status: "resolved";
  action: "keep_local" | "use_remote" | "use_merged";
  conflictId: string;
  roleId: string;
  path: string;
  publish: {
    status: "published" | "not_published";
    transport?: "lan" | "relay";
    message?: string;
  };
};

export type PersonaSyncContent = {
  bytes: Uint8Array;
  sha256: string;
};

type ApiEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

async function jsonRequest<T>(url: string, init?: RequestInit, allowConflict = false): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  const accepted = response.ok || (allowConflict && response.status === 409 && body.data != null);
  if (!accepted || body.data == null) {
    throw new Error(body.message || `Persona sync request failed (HTTP ${response.status}).`);
  }
  return body.data;
}

async function binaryRequest(url: string, hashHeaders: string[]): Promise<PersonaSyncContent> {
  const response = await fetch(url, { headers: { accept: "application/octet-stream" } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiEnvelope<never>;
    throw new Error(body.message || `Persona sync content request failed (HTTP ${response.status}).`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    sha256: hashHeaders.map(name => response.headers.get(name)).find(Boolean) || ""
  };
}

export const personaSyncClient = {
  peers(): Promise<{ peers: PersonaSyncPeer[] }> {
    return jsonRequest("/api/persona-sync/peers");
  },

  indexStatus(): Promise<PersonaSyncIndexStatus> {
    return jsonRequest("/api/persona-sync/index-status");
  },

  autoStatus(): Promise<PersonaSyncAutoStatus> {
    return jsonRequest("/api/persona-sync/auto-status");
  },

  conflicts(roleId: string): Promise<{ conflicts: PersonaSyncConflict[]; scan?: PersonaSyncConflictScan }> {
    const query = new URLSearchParams({ roleId });
    return jsonRequest(`/api/persona-sync/conflicts?${query}`);
  },

  sync(peerId: string, roleId: string): Promise<PersonaSyncResult> {
    return jsonRequest("/api/persona-sync/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ peerId, roleId })
    }, true);
  },

  preview(peerId: string, roleId: string): Promise<PersonaSyncPreview> {
    const query = new URLSearchParams({ peerId, roleId });
    return jsonRequest(`/api/persona-sync/preview?${query}`);
  },

  file(roleId: string, relativePath: string): Promise<PersonaSyncContent> {
    const role = encodeURIComponent(roleId);
    const path = encodeURIComponent(relativePath);
    return binaryRequest(`/api/persona-sync/files/${role}/${path}`, ["x-rabi-sha256"]);
  },

  localContent(conflict: PersonaSyncConflict): Promise<PersonaSyncContent> {
    return this.file(conflict.roleId, conflict.path);
  },

  remoteContent(conflictId: string): Promise<PersonaSyncContent> {
    const query = new URLSearchParams({ conflictId });
    return binaryRequest(`/api/persona-sync/conflicts/content?${query}`, ["x-rabi-remote-sha256"]);
  },

  resolve(conflict: PersonaSyncConflict, action: "keep_local" | "use_remote"): Promise<PersonaSyncConflictResolution> {
    return jsonRequest("/api/persona-sync/conflicts/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conflictId: conflict.conflictId,
        action,
        expectedLocalHash: conflict.localHash
      })
    });
  }
};
