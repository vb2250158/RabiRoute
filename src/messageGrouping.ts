import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import type { MessageGroupingPolicy } from "./shared/gatewayConfigModel.js";

export const MESSAGE_GROUP_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_MESSAGE_GROUP_RETRY_SECONDS = 5;
export const MAX_MESSAGE_GROUP_DELIVERED_IDENTITIES = 2_000;

export type MessageGroupPayload = {
  routeKind: string;
  record: Record<string, unknown>;
  extraValues: Record<string, string | number | undefined>;
};

export type MessageGroupItem = {
  identity: string;
  receivedAt: number;
  incomplete: boolean;
  payload: MessageGroupPayload;
};

export type PendingMessageGroup = {
  groupId: string;
  key: string;
  baseKey: string;
  endpoint: string;
  conversationKey: string;
  sender: string;
  replyToMessageId?: string;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  maxDeadlineAt: number;
  status: "pending" | "delivering";
  attempts: number;
  lastError?: string;
  items: MessageGroupItem[];
};

export type MessageGroupingState = {
  schemaVersion: 1;
  updatedAt: string;
  pending: PendingMessageGroup[];
  deliveredIdentities: string[];
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type MessageGroupingDependencies = {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
};

export type EnqueueMessageGroupInput = {
  key: string;
  baseKey: string;
  endpoint: string;
  conversationKey: string;
  sender: string;
  replyToMessageId?: string;
  identity: string;
  text: string;
  policy: Required<MessageGroupingPolicy>;
  payload: MessageGroupPayload;
};

function normalizedSeconds(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, Math.min(300, number)) : fallback;
}

function normalizedPolicy(policy: Required<MessageGroupingPolicy>): Required<MessageGroupingPolicy> {
  const settleSeconds = normalizedSeconds(policy.settleSeconds, 6);
  const incompleteSettleSeconds = Math.max(settleSeconds, normalizedSeconds(policy.incompleteSettleSeconds, 12));
  return {
    enabled: policy.enabled === true,
    settleSeconds,
    incompleteSettleSeconds,
    maxWaitSeconds: Math.max(incompleteSettleSeconds, normalizedSeconds(policy.maxWaitSeconds, 20))
  };
}

export function messageFragmentLooksIncomplete(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/[，,：:、…~—-]$/.test(text)) return true;
  return /(?:还有|然后|另外|以及|而且|但是|不过|就是|这个|那个|等下|稍等|and|then|also|but|because)$/i.test(text);
}

function normalizeItem(value: unknown): MessageGroupItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<MessageGroupItem>;
  if (!item.identity || !Number.isFinite(item.receivedAt) || !item.payload || typeof item.payload !== "object") {
    return undefined;
  }
  const payload = item.payload as Partial<MessageGroupPayload>;
  if (!payload.routeKind || !payload.record || typeof payload.record !== "object" || Array.isArray(payload.record)) {
    return undefined;
  }
  return {
    identity: String(item.identity),
    receivedAt: Number(item.receivedAt),
    incomplete: item.incomplete === true,
    payload: {
      routeKind: String(payload.routeKind),
      record: payload.record as Record<string, unknown>,
      extraValues: payload.extraValues && typeof payload.extraValues === "object" && !Array.isArray(payload.extraValues)
        ? payload.extraValues as Record<string, string | number | undefined>
        : {}
    }
  };
}

function normalizeGroup(value: unknown): PendingMessageGroup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const group = value as Partial<PendingMessageGroup>;
  const items = Array.isArray(group.items) ? group.items.flatMap((item) => normalizeItem(item) ?? []) : [];
  if (
    !group.groupId
    || !group.key
    || !group.baseKey
    || !group.endpoint
    || !group.conversationKey
    || !group.sender
    || !Number.isFinite(group.createdAt)
    || !Number.isFinite(group.deadlineAt)
    || items.length === 0
  ) {
    return undefined;
  }
  const createdAt = Number(group.createdAt);
  const deadlineAt = Number(group.deadlineAt);
  const maxDeadlineAt = Number.isFinite(group.maxDeadlineAt)
    ? Math.max(deadlineAt, Number(group.maxDeadlineAt))
    : Math.max(createdAt, deadlineAt);
  return {
    groupId: String(group.groupId),
    key: String(group.key),
    baseKey: String(group.baseKey),
    endpoint: String(group.endpoint),
    conversationKey: String(group.conversationKey),
    sender: String(group.sender),
    replyToMessageId: group.replyToMessageId == null ? undefined : String(group.replyToMessageId),
    createdAt,
    updatedAt: Number.isFinite(group.updatedAt) ? Number(group.updatedAt) : createdAt,
    deadlineAt,
    maxDeadlineAt,
    status: "pending",
    attempts: Math.max(0, Math.floor(Number(group.attempts) || 0)),
    lastError: typeof group.lastError === "string" && group.lastError ? group.lastError : undefined,
    items
  };
}

function readState(statePath: string): MessageGroupingState | undefined {
  if (!fs.existsSync(statePath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<MessageGroupingState>;
    if (parsed.schemaVersion !== MESSAGE_GROUP_STATE_SCHEMA_VERSION) return undefined;
    return {
      schemaVersion: MESSAGE_GROUP_STATE_SCHEMA_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      pending: Array.isArray(parsed.pending) ? parsed.pending.flatMap((group) => normalizeGroup(group) ?? []) : [],
      deliveredIdentities: Array.isArray(parsed.deliveredIdentities)
        ? parsed.deliveredIdentities.map(String).filter(Boolean).slice(-MAX_MESSAGE_GROUP_DELIVERED_IDENTITIES)
        : []
    };
  } catch {
    return undefined;
  }
}

export class MessageGroupingQueue {
  private readonly groups = new Map<string, PendingMessageGroup>();
  private readonly deliveredIdentities = new Set<string>();
  private readonly timers = new Map<string, TimerHandle>();
  private readonly now: () => number;
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly cancelTimer: (handle: TimerHandle) => void;

  constructor(
    private readonly statePath: string,
    private readonly deliver: (group: PendingMessageGroup) => Promise<void>,
    dependencies: MessageGroupingDependencies = {}
  ) {
    this.now = dependencies.now ?? (() => Date.now());
    this.scheduleTimer = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelTimer = dependencies.cancel ?? ((handle) => clearTimeout(handle));
    const state = readState(statePath);
    for (const identity of state?.deliveredIdentities ?? []) this.deliveredIdentities.add(identity);
    for (const recovered of state?.pending ?? []) {
      const group = { ...recovered, status: "pending" as const };
      this.groups.set(group.key, group);
      this.arm(group);
    }
  }

  enqueue(input: EnqueueMessageGroupInput): { groupId: string; accepted: boolean; itemCount: number } {
    if (this.deliveredIdentities.has(input.identity)) {
      return { groupId: "", accepted: false, itemCount: 0 };
    }
    const baseCandidates = input.replyToMessageId
      ? []
      : [...this.groups.values()].filter((group) => group.baseKey === input.baseKey && group.status === "pending");
    const existing = this.groups.get(input.key) ?? (baseCandidates.length === 1 ? baseCandidates[0] : undefined);
    if (existing?.items.some((item) => item.identity === input.identity)) {
      return { groupId: existing.groupId, accepted: false, itemCount: existing.items.length };
    }
    const now = this.now();
    const policy = normalizedPolicy(input.policy);
    const incomplete = messageFragmentLooksIncomplete(input.text);
    const group = existing ?? {
      groupId: `message-group-${randomUUID()}`,
      key: input.key,
      baseKey: input.baseKey,
      endpoint: input.endpoint,
      conversationKey: input.conversationKey,
      sender: input.sender,
      replyToMessageId: input.replyToMessageId,
      createdAt: now,
      updatedAt: now,
      deadlineAt: now,
      maxDeadlineAt: now + policy.maxWaitSeconds * 1_000,
      status: "pending" as const,
      attempts: 0,
      items: []
    };
    const wasDelivering = group.status === "delivering";
    group.updatedAt = now;
    if (!wasDelivering) group.status = "pending";
    group.lastError = undefined;
    group.items.push({
      identity: input.identity,
      receivedAt: now,
      incomplete,
      payload: input.payload
    });
    if (wasDelivering) {
      group.maxDeadlineAt = Math.max(group.maxDeadlineAt, now + policy.maxWaitSeconds * 1_000);
    }
    const waitSeconds = incomplete ? policy.incompleteSettleSeconds : policy.settleSeconds;
    group.deadlineAt = Math.min(group.maxDeadlineAt, now + waitSeconds * 1_000);
    this.groups.set(group.key, group);
    this.persist();
    if (!wasDelivering) this.arm(group);
    return { groupId: group.groupId, accepted: true, itemCount: group.items.length };
  }

  async flushNow(key: string): Promise<boolean> {
    const group = this.groups.get(key);
    if (!group || group.status === "delivering") return false;
    this.disarm(key);
    group.status = "delivering";
    group.attempts += 1;
    group.lastError = undefined;
    this.persist();
    const deliveredIdentities = new Set(group.items.map((item) => item.identity));
    try {
      await this.deliver(structuredClone(group));
      group.items = group.items.filter((item) => !deliveredIdentities.has(item.identity));
      for (const identity of deliveredIdentities) this.deliveredIdentities.add(identity);
      while (this.deliveredIdentities.size > MAX_MESSAGE_GROUP_DELIVERED_IDENTITIES) {
        const oldest = this.deliveredIdentities.values().next().value as string | undefined;
        if (!oldest) break;
        this.deliveredIdentities.delete(oldest);
      }
      if (group.items.length === 0) {
        this.groups.delete(key);
      } else {
        group.status = "pending";
        group.attempts = 0;
        group.lastError = undefined;
        group.createdAt = group.items[0]!.receivedAt;
        this.arm(group);
      }
      this.persist();
      return true;
    } catch (error) {
      group.status = "pending";
      group.lastError = error instanceof Error ? error.message : String(error);
      const retrySeconds = Math.min(60, DEFAULT_MESSAGE_GROUP_RETRY_SECONDS * (2 ** Math.min(4, group.attempts - 1)));
      group.deadlineAt = this.now() + retrySeconds * 1_000;
      group.maxDeadlineAt = Math.max(group.maxDeadlineAt, group.deadlineAt);
      this.persist();
      this.arm(group);
      return false;
    }
  }

  snapshot(): MessageGroupingState {
    return {
      schemaVersion: MESSAGE_GROUP_STATE_SCHEMA_VERSION,
      updatedAt: new Date(this.now()).toISOString(),
      pending: [...this.groups.values()].map((group) => structuredClone(group)),
      deliveredIdentities: [...this.deliveredIdentities]
    };
  }

  close(): void {
    for (const key of this.timers.keys()) this.disarm(key);
    this.persist();
  }

  private arm(group: PendingMessageGroup): void {
    this.disarm(group.key);
    const delayMs = Math.max(0, group.deadlineAt - this.now());
    const handle = this.scheduleTimer(() => {
      this.timers.delete(group.key);
      void this.flushNow(group.key);
    }, delayMs);
    this.timers.set(group.key, handle);
  }

  private disarm(key: string): void {
    const timer = this.timers.get(key);
    if (timer) this.cancelTimer(timer);
    this.timers.delete(key);
  }

  private persist(): void {
    const state = this.snapshot();
    atomicWriteFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function messageGroupingStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "message-groups", "pending.json");
}
