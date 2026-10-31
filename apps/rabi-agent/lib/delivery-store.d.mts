export type StoredDeliveryState = "pending" | "sending" | "unknown" | "delivered" | "blocked" | "cancelled";
export type StoredDeliveryRecord = { intentId: string; kind: string; state: StoredDeliveryState; payloadHash: string; attempts: number;
  createdAt: string; updatedAt: string; nextAttemptAt: string | null; error: string | null; receipt?: Record<string, unknown> };
export type RawDeliveryRecord = { id: string; kind: string; state: StoredDeliveryState; payload: Record<string, unknown>; attempts: number; receipt: string | null; manager_guid?: string | null; manager_origin?: string | null; target_key?: string | null };
export function canonicalJson(value: unknown): string;
export function contentHash(value: unknown): string;
export class DeliveryStore {
  constructor(filename: string, options?: { maxPending?: number; maxBytes?: number; now?: () => number });
  submit(id: string, kind: string, payload: unknown, binding?: { managerGuid?: string; managerOrigin?: string; managerHint?: string; targetKey?: string }): StoredDeliveryRecord;
  get(id: string): StoredDeliveryRecord | undefined;
  raw(id: string): RawDeliveryRecord | undefined;
  taskManagerGuid(taskId: string): string | undefined;
  list(options?: { cursor?: string; limit?: number; state?: string; query?: string }): { items: StoredDeliveryRecord[]; nextCursor: string | null; counts: Record<string, number> };
  due(limit?: number, options?: { ordered?: boolean; perTarget?: number; excludeIds?: string[]; activeTargets?: { targetKey: string; slots: number }[] }): RawDeliveryRecord[];
  bindManagerGuid(id: string, guid: string): void;
  update(id: string, state: StoredDeliveryState, options?: { error?: string | null; receipt?: Record<string, unknown>; delayMs?: number; attempt?: boolean }): StoredDeliveryRecord | undefined;
  acknowledgeEvent(id: string, taskId: string): boolean;
  close(): void;
}
