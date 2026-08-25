export const WORK_END_EVENT_SCHEMA_VERSION = 1 as const;
export const WORK_END_EVENT_MAX_SUMMARY_CHARS = 1_000;

export type WorkEndStatus = "completed" | "failed" | "cancelled";

export type WorkEndedEventInput = {
  id?: string;
  source: string;
  sessionId: string;
  turnId?: string;
  personaId?: string;
  status: WorkEndStatus;
  summary: string;
  taskName?: string;
  isChild?: boolean;
  occurredAt?: string;
};
export type WorkEndedEvent = {
  schemaVersion: typeof WORK_END_EVENT_SCHEMA_VERSION;
  id: string;
  source: string;
  sessionId: string;
  turnId: string;
  personaId: string;
  status: WorkEndStatus;
  summary: string;
  taskName?: string;
  isChild: boolean;
  occurredAt: string;
  receivedAt: string;
};

export type WorkEndConsumerReceipt = {
  handled: boolean;
  reason?: string;
  spoken?: boolean;
  playbackJobId?: string;
};

export type WorkEndReceipt = {
  accepted: boolean;
  duplicate: boolean;
  eventId: string;
  consumers: Record<string, WorkEndConsumerReceipt>;
};
