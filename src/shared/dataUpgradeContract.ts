/** Shared WebGUI/Manager contract. Status is a cached metadata snapshot. */
export type DataUpgradeState = "checking" | "current" | "available" | "running" | "awaiting-restart" | "succeeded" | "failed" | "interrupted";
export type DataUpgradeItemState = "pending" | "current" | "running" | "awaiting-restart" | "succeeded" | "failed";
export type DataUpgradeItem = Readonly<{
  id: string;
  title: string;
  description: string;
  fromVersion?: string;
  toVersion?: string;
  recordCount?: number;
  bytes?: number;
  /** Private-owner metadata revision used to bind confirmation to the discovered inputs. */
  inputFingerprint?: string;
  state: DataUpgradeItemState;
  error?: string;
}>;
export type DataUpgradeOperation = Readonly<{
  operationId: string;
  state: "running" | "awaiting-restart" | "succeeded" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  completedItems: number;
  totalItems: number;
  currentItemId?: string;
  error?: string;
  requiresRestart?: boolean;
}>;
export type DataUpgradeStatus = Readonly<{
  revision: number;
  state: DataUpgradeState;
  items: readonly DataUpgradeItem[];
  operation?: DataUpgradeOperation;
  restartRequired?: boolean;
}>;
export type DataUpgradeStartRequest = Readonly<{ operationId: string; expectedRevision: number }>;
/** GET status, POST start and data-upgrade-status event all carry DataUpgradeStatus directly. */
export const DATA_UPGRADE_STATUS_EVENT = "data-upgrade-status";
