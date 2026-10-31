import type { DeliveryStore, StoredDeliveryRecord } from "./delivery-store.mjs";
export type DeliveryRecord = {
  id: string; intentId: string; deliveryId: string; state: "queued" | "sending" | "awaiting_confirmation" | "received" | "blocked" | "cancelled";
  ownerScope: "node"; source: { nodeId: string; provider?: string; sessionId?: string }; target: { instanceId?: string; provider?: string; sessionId?: string };
  createdAt: string; updatedAt: string; nextAttemptAt?: string; attemptCount: number; reason?: string; receipt?: Record<string, unknown>;
};
export type DeliveryQuery = { action?: "list" | "get"; intentId?: string; cursor?: string; limit?: number; state?: string; query?: string };
export type DeliveryPage = { item?: DeliveryRecord | null; items?: DeliveryRecord[]; nextCursor?: string | null; counts?: Record<string, number>;
  coverage: { scope: "node"; nodeId: string; connected: boolean; includesDisconnectedNodeQueues: boolean; message?: string }; observedAt: string };
export type TransportReceipt = { ok?: boolean; statusCode?: number; body?: string; uncertain?: boolean; identityChanged?: boolean };
export type ReliableDeliveryInput = { intentId: string; agentType: string; sessionId: string; request: Record<string, unknown> };
export class DeliveryOwner {
  constructor(options: { configPath: string; config: Record<string, unknown>; store?: DeliveryStore; now?: () => number; random?: () => number;
    readIdentity?: () => Record<string, unknown>; resolveManagerIdentity?: () => Promise<{ guid: string }>;
    client: (agentType: string, sessionId: string, managerGuid: string) => { request(method: string, target: string, options?: Record<string, unknown>): Promise<TransportReceipt> };
    sendEvent: (payload: Record<string, unknown>, managerGuid: string) => unknown });
  store: DeliveryStore;
  flight: Promise<void> | null;
  paused: boolean;
  submit(input: ReliableDeliveryInput): { ok: true; accepted: true; acceptance: "local-durable"; record: StoredDeliveryRecord };
  enqueueResult(payload: Record<string, unknown>, managerGuid?: string | null): string;
  query(input?: DeliveryQuery): DeliveryPage;
  acknowledge(message: { eventId: string; taskId: string }, managerGuid?: string | null): boolean;
  start(): void;
  wake(): void;
  tick(): Promise<void>;
  pause(): Promise<void>;
  resume(): void;
  close(): Promise<void>;
}
