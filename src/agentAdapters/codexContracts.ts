import type { CodexReasoningEffort } from "../shared/gatewayConfigModel.js";

export type CodexDesktopReasoningEffort = CodexReasoningEffort;
export type CodexDesktopSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexDesktopDelivery = { threadId: string; action: "started" | "steered"; openedThread: boolean; transport: "desktop-ipc" };
export const CODEX_DESKTOP_LATE_RECEIPT_WINDOW_MS = 60_000;

export type CodexMonitorThread = {
  id: string;
  threadName: string;
  updatedAt: string;
  source: string;
  cwd?: string;
};

export type CodexIdleNotificationResult = {
  status: "delivered" | "busy";
  thread: CodexMonitorThread;
};

export type CodexTurnSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type CodexNotificationTurnOptions = {
  model: string;
  reasoningEffort?: CodexDesktopReasoningEffort;
};

export type CodexThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd?: string;
  archived?: boolean;
};

export type CodexThreadRuntimeStatus = "active" | "idle" | "notLoaded" | "unavailable";

export type CodexThreadCreateParams = {
  title: string;
  prompt: string;
  cwd: string;
  developerInstructions: string;
  sandbox: CodexTurnSandbox;
  onCreationStage?: (state: "thread_created" | "naming" | "initial_turn", threadId: string) => void;
};

export type CodexThreadCreateResult = CodexThreadSummary & {
  source: string;
  initialTurnStatus: "not-requested" | "started" | "failed";
  initialTurnError?: string;
};

export type CodexModelCatalogEntry = {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts: Array<{ id: string; description?: string }>;
};

export type CodexNativeOperations = {
  listCodexModels(cwd: string, timeoutMs?: number): Promise<CodexModelCatalogEntry[]>;
  listCodexThreads(options: {
  query?: string;
  limit?: number;
  offset?: number;
  allowedWorkspaces: string[];
  stateDbOnly?: boolean;
  signal?: AbortSignal;
}): Promise<CodexThreadSummary[]>;
  readCodexThread(threadId: string): Promise<unknown>;
  renameCodexThread(params: {
  threadId: string;
  title: string;
  cwd: string;
}): Promise<CodexThreadSummary>;
  createCodexThread(params: CodexThreadCreateParams): Promise<CodexThreadCreateResult>;
  sendCodexThreadMessage(params: {
  assertAuthorized?: () => void | Promise<void>;
  threadId: string;
  prompt: string;
  cwd: string;
  sandbox: CodexTurnSandbox;
  model?: string;
  reasoningEffort?: CodexDesktopReasoningEffort;
  imagePaths?: string[];
}): Promise<CodexDesktopDelivery & { warning?: string }>;
  isCodexMonitorThreadActive(): Promise<boolean>;
  notifyCodex(message: string, imagePaths?: string[]): Promise<CodexMonitorThread>;
  notifyCodexWhenIdle(message: string, turnOptions?: CodexNotificationTurnOptions): Promise<CodexIdleNotificationResult>;
  isCodexDesktopReady(): Promise<boolean>;
  openCodexDesktopThread(threadId: string): Promise<void>;
  codexDesktopDeliveryReceiptConfirmed(threadId: string, deliveryMarker: string): Promise<boolean>;
  promptConfirmsDelivery(prompt: string, deliveryId: string): boolean;
};

export type CodexSessionThread = {
  id: string;
  title: string;
  updatedAt?: string;
  cwd?: string;
  archived?: boolean;
};

export type CodexSessionResolution<TThread extends CodexSessionThread> =
  | { kind: "id" | "name" | "created"; thread: TThread }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: TThread[] }
  | { kind: "archived"; thread: TThread };

export type CodexSessionResolverDependencies<TThread extends CodexSessionThread> = {
  /** Stable owner used to share in-flight/recent creations across requests. */
  scope: object;
  read: (threadId: string) => Promise<TThread | null>;
  list: (params: { title: string; cwd: string }) => Promise<TThread[]>;
  create: (context?: {
    reason: "missing" | "archived";
    previousThread?: TThread;
  }) => Promise<TThread>;
};

export type CodexSessionDeliveryDependencies<TThread extends CodexSessionThread> =
  CodexSessionResolverDependencies<TThread> & {
    deliver: (params: { thread: TThread; prompt: string }) => Promise<void>;
  };
