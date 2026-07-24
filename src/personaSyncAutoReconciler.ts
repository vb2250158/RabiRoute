import fs from "node:fs";
import path from "node:path";
import type { PersonaSyncResult, PersonaSyncPeer } from "./personaSyncCoordinator.js";
import type { PersonaSyncManifestIndexEvent } from "./personaSyncManifestIndex.js";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { sanitizeRoleId } from "./shared/routeIdentity.js";

const AUTO_SYNC_STATE_VERSION = 1;
const DEFAULT_SETTLE_MS = 600;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

type PersonaSyncAutoCoordinator = {
  peers(): Promise<PersonaSyncPeer[]>;
  sync(peerId: string, roleId?: string): Promise<PersonaSyncResult>;
};

type PersistedPersonaSyncAutoState = {
  schemaVersion: 1;
  needsFullSync: boolean;
  roleIds: string[];
  updatedAt: string;
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

export type PersonaSyncAutoReconcilerOptions = {
  enabled?: boolean;
  settleMs?: number;
  retryBaseMs?: number;
  maxRetryAttempts?: number;
  onStatus?: (status: PersonaSyncAutoStatus) => void;
};

function cloneStatus(status: PersonaSyncAutoStatus): PersonaSyncAutoStatus {
  return {
    ...status,
    lastOutcome: status.lastOutcome ? { ...status.lastOutcome } : undefined
  };
}

function numericOption(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Owns only automatic reconciliation scheduling and its durable pending marker.
 * PersonaSyncCoordinator remains the sole owner of discovery, transport, merge,
 * deletion, and conflict semantics.
 */
export class PersonaSyncAutoReconciler {
  private readonly statePath: string;
  private readonly enabled: boolean;
  private readonly settleMs: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryAttempts: number;
  private readonly onStatus?: (status: PersonaSyncAutoStatus) => void;
  private needsFullSync = false;
  private readonly pendingRoleIds = new Set<string>();
  private revision = 0;
  private lifecycleGeneration = 0;
  private started = false;
  private relayOnline = false;
  private retryAttempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private deferredDelayMs: number | null = null;
  private runFlight: Promise<void> | null = null;
  private currentStatus: PersonaSyncAutoStatus = {
    state: "stopped",
    relayOnline: false,
    pending: false,
    pendingFullSync: false,
    pendingRoleCount: 0,
    retryAttempt: 0
  };

  constructor(
    readonly coordinator: PersonaSyncAutoCoordinator,
    readonly stateRoot: string,
    options: PersonaSyncAutoReconcilerOptions = {}
  ) {
    this.statePath = path.join(stateRoot, "auto-sync-state.json");
    this.enabled = options.enabled !== false;
    this.settleMs = Math.max(0, numericOption(options.settleMs, DEFAULT_SETTLE_MS));
    this.retryBaseMs = Math.max(10, numericOption(options.retryBaseMs, DEFAULT_RETRY_BASE_MS));
    this.maxRetryAttempts = Math.max(0, Math.min(8, numericOption(options.maxRetryAttempts, DEFAULT_MAX_RETRY_ATTEMPTS)));
    this.onStatus = options.onStatus;
    this.loadPendingState();
    this.publishStatus("stopped");
  }

  start(): void {
    if (this.started || !this.enabled) return;
    this.lifecycleGeneration += 1;
    this.started = true;
    // A process restart can miss any number of remote file events. The Relay
    // ready event will turn this durable full reconciliation marker into one
    // manifest comparison; it is not a periodic scan.
    this.markFullSync();
    this.publishStatus("waiting_relay");
  }

  stop(): void {
    this.lifecycleGeneration += 1;
    this.started = false;
    this.relayOnline = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deferredDelayMs = null;
    this.persistPendingState();
    this.publishStatus("stopped");
  }

  status(): PersonaSyncAutoStatus {
    return cloneStatus(this.currentStatus);
  }

  noteRelayStatus(state: string): void {
    if (!this.started) return;
    const online = state === "online";
    this.relayOnline = online;
    if (!online) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.deferredDelayMs = null;
      this.publishStatus("waiting_relay");
      return;
    }
    this.markFullSync();
    this.schedule(0);
  }

  noteRelayEvent(eventType: string): void {
    if (!this.started) return;
    if (eventType === "ready") {
      this.relayOnline = true;
      this.markFullSync();
      this.schedule(0);
      return;
    }
    if (eventType === "persona_sync_peer_changed") {
      this.markFullSync();
      if (this.relayOnline) this.schedule(0);
    }
  }

  noteManifestEvent(event: PersonaSyncManifestIndexEvent): void {
    if (!this.started || event.kind === "ready" || event.kind === "watch_unavailable") return;
    const roleId = sanitizeRoleId(event.roleId);
    if (roleId) this.markRoleSync(roleId);
    else this.markFullSync();
    if (this.relayOnline) this.schedule(this.settleMs);
  }

  private markFullSync(): void {
    this.needsFullSync = true;
    this.pendingRoleIds.clear();
    this.revision += 1;
    this.retryAttempt = 0;
    this.persistPendingState();
    this.publishStatus(this.relayOnline ? "scheduled" : "waiting_relay");
  }

  private markRoleSync(roleId: string): void {
    if (!this.needsFullSync) this.pendingRoleIds.add(roleId);
    this.revision += 1;
    this.retryAttempt = 0;
    this.persistPendingState();
    this.publishStatus(this.relayOnline ? "scheduled" : "waiting_relay");
  }

  private hasPending(): boolean {
    return this.needsFullSync || this.pendingRoleIds.size > 0;
  }

  private schedule(delayMs: number): void {
    if (!this.started || !this.relayOnline || !this.hasPending() || this.timer) return;
    this.publishStatus("scheduled");
    if (this.runFlight) {
      this.deferredDelayMs = this.deferredDelayMs == null
        ? Math.max(0, delayMs)
        : Math.min(this.deferredDelayMs, Math.max(0, delayMs));
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, Math.max(0, delayMs));
    this.timer.unref();
  }

  private runOnce(): Promise<void> {
    if (this.runFlight) return this.runFlight;
    const lifecycleGeneration = this.lifecycleGeneration;
    this.runFlight = this.performRun(lifecycleGeneration).finally(() => {
      this.runFlight = null;
      if (this.currentStatus.state === "scheduled" && this.started && this.relayOnline && this.hasPending() && !this.timer) {
        const delay = this.deferredDelayMs ?? this.settleMs;
        this.deferredDelayMs = null;
        this.schedule(delay);
      }
    });
    return this.runFlight;
  }

  private active(lifecycleGeneration: number): boolean {
    return this.started && this.lifecycleGeneration === lifecycleGeneration;
  }

  private async performRun(lifecycleGeneration: number): Promise<void> {
    if (!this.active(lifecycleGeneration) || !this.relayOnline || !this.hasPending()) return;
    const snapshotRevision = this.revision;
    const fullSync = this.needsFullSync;
    const roleIds = fullSync ? [] : [...this.pendingRoleIds].sort((left, right) => left.localeCompare(right));
    const lastRunAt = new Date().toISOString();
    this.publishStatus("syncing", { lastRunAt, lastError: undefined });
    let peers: PersonaSyncPeer[];
    try {
      peers = await this.coordinator.peers();
    } catch (error) {
      if (!this.active(lifecycleGeneration)) return;
      this.handleFailure(error, { peersSeen: 0, peersSynced: 0, conflicts: 0, failures: 1, lan: 0, relay: 0 });
      return;
    }
    if (!this.active(lifecycleGeneration)) return;
    const onlinePeers = peers.filter(peer => peer.online && peer.capabilities.includes("persona-sync"));
    if (!onlinePeers.length) {
      this.retryAttempt = 0;
      this.publishStatus("waiting_peer", {
        lastRunAt,
        lastError: undefined,
        lastOutcome: { peersSeen: peers.length, peersSynced: 0, conflicts: 0, failures: 0, lan: 0, relay: 0 }
      });
      return;
    }

    const outcome = { peersSeen: peers.length, peersSynced: 0, conflicts: 0, failures: 0, lan: 0, relay: 0 };
    let firstError: unknown;
    for (const peer of onlinePeers) {
      if (!this.active(lifecycleGeneration)) return;
      try {
        const results = fullSync
          ? [await this.coordinator.sync(peer.id)]
          : await Promise.all(roleIds.map(roleId => this.coordinator.sync(peer.id, roleId)));
        if (!this.active(lifecycleGeneration)) return;
        outcome.peersSynced += 1;
        for (const result of results) {
          outcome.conflicts += result.conflicts;
          outcome[result.transport] += 1;
        }
      } catch (error) {
        if (!this.active(lifecycleGeneration)) return;
        outcome.failures += 1;
        firstError ??= error;
      }
    }
    if (!this.active(lifecycleGeneration)) return;
    if (outcome.failures > 0) {
      this.handleFailure(firstError, outcome);
      return;
    }

    this.retryAttempt = 0;
    if (this.revision === snapshotRevision) {
      this.needsFullSync = false;
      this.pendingRoleIds.clear();
      this.persistPendingState();
    }
    const now = new Date().toISOString();
    this.publishStatus(outcome.conflicts > 0 ? "attention" : this.hasPending() ? "scheduled" : "idle", {
      lastRunAt,
      lastSuccessAt: now,
      lastError: undefined,
      lastOutcome: outcome
    });
  }

  private handleFailure(error: unknown, outcome: NonNullable<PersonaSyncAutoStatus["lastOutcome"]>): void {
    const message = error instanceof Error ? error.message : String(error || "Persona synchronization failed.");
    this.retryAttempt += 1;
    this.publishStatus("error", { lastError: message, lastOutcome: outcome });
    if (this.retryAttempt > this.maxRetryAttempts || !this.relayOnline) return;
    const delay = Math.min(30_000, this.retryBaseMs * (2 ** Math.max(0, this.retryAttempt - 1)));
    this.schedule(delay);
  }

  private publishStatus(state: PersonaSyncAutoStatus["state"], patch: Partial<PersonaSyncAutoStatus> = {}): void {
    this.currentStatus = {
      ...this.currentStatus,
      ...patch,
      state,
      relayOnline: this.relayOnline,
      pending: this.hasPending(),
      pendingFullSync: this.needsFullSync,
      pendingRoleCount: this.pendingRoleIds.size,
      retryAttempt: this.retryAttempt
    };
    try {
      this.onStatus?.(this.status());
    } catch {
      // Scheduling correctness does not depend on observers.
    }
  }

  private persistPendingState(): void {
    if (!this.enabled) return;
    const payload: PersistedPersonaSyncAutoState = {
      schemaVersion: AUTO_SYNC_STATE_VERSION,
      needsFullSync: this.needsFullSync,
      roleIds: [...this.pendingRoleIds].sort((left, right) => left.localeCompare(right)),
      updatedAt: new Date().toISOString()
    };
    atomicWriteFileSync(this.statePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  private loadPendingState(): void {
    let parsed: Partial<PersistedPersonaSyncAutoState>;
    try {
      parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<PersistedPersonaSyncAutoState>;
    } catch {
      return;
    }
    if (parsed.schemaVersion !== AUTO_SYNC_STATE_VERSION) return;
    this.needsFullSync = parsed.needsFullSync === true;
    for (const raw of Array.isArray(parsed.roleIds) ? parsed.roleIds : []) {
      const roleId = sanitizeRoleId(raw);
      if (roleId) this.pendingRoleIds.add(roleId);
    }
  }
}
