/** Read-only projection of a delivery owner's durable records, never a second ledger. */
export type AgentDeliveryRecordState = "queued" | "sending" | "awaiting_confirmation" | "received" | "blocked" | "failed" | "cancelled";

export type AgentDeliveryRecordParty = {
  kind?: string;
  connection?: { managerInstanceId: string; transport: string; id: string };
  instanceId?: string;
  nodeId?: string;
  provider?: string;
  sessionId?: string;
};

export type AgentDeliveryRecord = {
  id: string;
  deliveryId: string;
  intentId?: string;
  state: AgentDeliveryRecordState;
  source: AgentDeliveryRecordParty;
  target: AgentDeliveryRecordParty;
  createdAt?: string;
  updatedAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  attemptCount?: number;
  reason?: string;
  errorCode?: string;
  field?: string;
  repair?: string;
  receipt?: Record<string, unknown>;
  targetAcceptedAt?: string;
  /** The computer stopped its queue; the original Manager reservation still needs cancellation. */
  managerCancelPending?: boolean;
  ownerScope: "manager" | "node";
};

export type AgentDeliveryRecordPage = {
  records: AgentDeliveryRecord[];
  nextCursor?: string;
  observedAt: string;
  coverage: {
    scope: "manager" | "node";
    includesDisconnectedNodeQueues: boolean;
    nodeId?: string;
    connected?: boolean;
    message?: string;
  };
};
