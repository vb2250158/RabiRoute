/** Display identity only; never includes endpoint credentials or authorization incarnations. */
export type PersonaChatTaskOwner = {
  kind: "local" | "instance" | "device" | "service";
  provider: string;
  agentId: string;
  nodeId?: string;
  nodeName?: string;
};

/** Persona messages: Hook final replies and managed Agent-to-Agent deliveries. */
export type PersonaChatReply = {
  id: string;
  historyCursor?: number;
  historyEndCursor?: number;
  textTruncated?: boolean;
  receivedAt: string;
  sessionId: string;
  turnId?: string;
  kind?: "final_reply" | "agent_delivery" | "user_delivery" | "aiui_user" | "aiui_assistant";
  deliveryId?: string;
  sourceLabel?: string;
  planId?: string;
  planTitle?: string;
  feedbackId?: string;
  deliveryStatus?: "delivered" | "unconfirmed";
  targetSessionId?: string;
  targetSessionTitle?: string;
  targetTaskUrl?: string;
  sourceTaskOwner?: PersonaChatTaskOwner;
  targetTaskOwner?: PersonaChatTaskOwner;
  text: string;
  /** Recorded name, refreshed from the matching task owner when available. */
  sessionTitle?: string;
  taskUrl?: string;
};

export type PersonaChatHistoryPage = {
  entries: PersonaChatReply[];
  /** Exclusive byte offset in the append-only history; null means the beginning. */
  nextCursor: number | null;
  newerCursor?: number | null;
  invalidRecords?: number;
};
