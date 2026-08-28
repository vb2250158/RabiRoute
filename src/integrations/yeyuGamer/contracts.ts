export type YeYuGamerJsonObject = Record<string, unknown>;

export type YeYuGamerMeta = {
  name: string;
  version: string;
  apiVersion: "v1" | string;
  managerId: string;
  startedAt: string;
  hostPolicy: "loopback-only" | string;
  webGuiAvailable: boolean;
  legacyExecutionEnabled: boolean;
};

export type YeYuGamerHealthCheck = {
  status: "ok" | "degraded" | "error";
  detail: string;
};

export type YeYuGamerHealth = {
  status: "ok" | "degraded" | "error";
  manager: string;
  storage: string;
  eventStream: string;
  checkedAt: string;
  checks: Record<string, YeYuGamerHealthCheck>;
};

export type YeYuGamerGameSummary = {
  gameId: string;
  displayName: string;
  orderIndex: number;
  enabled: boolean;
  runtimeState: string;
  acceptanceState: string;
  reviewState: string;
  rewardClaimed: boolean;
  nextAction: string;
  updatedAt: string;
  policy: YeYuGamerJsonObject;
};

export type YeYuGamerBatchSummary = {
  batchId: string;
  cadence: "daily" | "weekly";
  state: string;
  gameIds: string[];
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  result: YeYuGamerJsonObject;
};

export type YeYuGamerSnapshot = {
  stateVersion: number;
  generatedAt: string;
  eventCursor: string;
  manager: YeYuGamerJsonObject;
  health: YeYuGamerJsonObject;
  gameDay: string;
  activeBatch: YeYuGamerJsonObject | null;
  recentBatches: YeYuGamerBatchSummary[];
  games: YeYuGamerGameSummary[];
  counters: Record<string, number>;
};

export type YeYuGamerCapability = {
  capabilityId: string;
  version: string;
  description: string;
  displayName: string;
  risk: "observe_only" | "controlled_write" | "routine_action" | "approval_required" | "forbidden";
  enabled: boolean;
  requiresIdempotencyKey: boolean;
  inputSchema: YeYuGamerJsonObject;
  outputSchema: YeYuGamerJsonObject;
  policy: YeYuGamerJsonObject;
  preEvidence: string[];
  postEvidence: string[];
  implementationHash: string;
};

export type YeYuGamerPage<T> = {
  items: T[];
  total: number;
};

export type YeYuGamerWorkItemKind =
  | "run_game"
  | "run_batch"
  | "diagnose_game"
  | "cancel_run"
  | "observation"
  | "incident_review"
  | "evidence_review"
  | "repair_validation";

/**
 * A RabiRoute dispatch creates a plan record only. The Manager owns all later
 * claiming, capability selection, execution and acceptance decisions.
 */
export type YeYuGamerWorkItemCreate = {
  kind: YeYuGamerWorkItemKind;
  gameId?: string;
  cadence?: "daily" | "weekly";
  runId?: string;
  note?: string;
  artifactRefs?: string[];
  allowedCapabilityRefs?: string[];
};

export type YeYuGamerCommandReceipt = {
  commandId: string;
  idempotencyKey: string;
  requestId: string | null;
  statusUrl: string | null;
  acceptedStateVersion: number;
  state: "accepted" | "running" | "succeeded" | "rejected" | "failed";
  message: string;
  result: YeYuGamerJsonObject;
  submittedAt: string;
  completedAt: string | null;
  replayed: boolean;
};

export type YeYuGamerDispatchOptions = {
  idempotencyKey: string;
  expectedStateVersion: number;
  requestId?: string;
};
