import type { PlanItem, PlanHistoryRecord, planUpdatePrimitives } from "../roleKnowledge.js";
import type { PersonaPlanWorkflow } from "../personaPlanWorkflow.js";
import type { PlanFeedbackRecord } from "../planFeedback.js";
import type { StorageMutationStamp } from "../shared/storageRevision.js";
import type { PlanStorageBucket } from "../planStorageRepository.js";

export type PlanUpdatePrimitives = typeof planUpdatePrimitives;

export type PlanUpdatePreparation = Readonly<{
  prepare(input: {
    roleDir: string;
    existing: PlanItem;
    patch: Record<string, unknown>;
    workflow: PersonaPlanWorkflow;
    recordedAt: string;
    mutation?: StorageMutationStamp;
  }): PlanItem;
  projectHistory(input: {
    roleDir: string;
    sourcePlan: PlanItem;
    next: PlanItem;
    currentBucket: PlanStorageBucket;
    destinationBucket: PlanStorageBucket;
    mutation?: StorageMutationStamp;
  }): PlanHistoryRecord;
  projectPlan(input: {
    plan: PlanItem;
    approval: { count: number; latest?: PlanFeedbackRecord };
    revision: string;
  }): { plan: PlanItem; approval: { count: number; latest?: PlanFeedbackRecord }; revision: string };
}>;

/** Persistent package identity only. Receipt audit may retain this value outside its business digest. */
export type PlanUpdateExecutorPin = Readonly<{
  pluginId: string;
  version: string;
  revision: string;
  entryPath: "worker/plan-update.mjs";
}>;

/** Parent-owned accepted work. Functions stay in the parent and never enter IPC or receipt JSON. */
export type PlanUpdateExecutorDescriptor = Readonly<{
  pin: PlanUpdateExecutorPin;
  entryUrl: string;
}>;

export type PlanUpdateExecutorLease = PlanUpdateExecutorDescriptor & Readonly<{
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  release(): void;
}>;

export type PlanUpdateExecutorCallbacks = Readonly<{
  /** Resolved lazily per admitted request. Constructors store this callback without acquiring it. */
  acquirePlanUpdateExecutor?: () => PlanUpdateExecutorLease | undefined;
  /** Reopen a retained exact package for an existing receipt after its activation retired. */
  restorePlanUpdateExecutor?: (pin: PlanUpdateExecutorPin) => Promise<PlanUpdateExecutorLease>;
}>;

export type PlanUpdateExecutorService = Readonly<{
  acquirePlanUpdateExecutor(): PlanUpdateExecutorLease;
}>;

/** Original receipt JSON is not executable authority. The package owner resolves its immutable entry. */
export function parsePlanUpdateExecutorPin(value: unknown): PlanUpdateExecutorPin {
  const pin = value as Partial<PlanUpdateExecutorPin> | null;
  if (!pin || typeof pin !== "object" || Array.isArray(pin)
    || typeof pin.pluginId !== "string" || !pin.pluginId
    || typeof pin.version !== "string" || !pin.version || /[/\\]/.test(pin.version)
    || pin.version === "." || pin.version === ".."
    || typeof pin.revision !== "string" || !/^[a-f0-9]{64}$/.test(pin.revision)
    || pin.entryPath !== "worker/plan-update.mjs") {
    throw new Error("The original plan executor package reference is invalid.");
  }
  return Object.freeze({ pluginId: pin.pluginId, version: pin.version, revision: pin.revision, entryPath: pin.entryPath });
}

export function samePlanUpdateExecutorPin(left: PlanUpdateExecutorPin, right: PlanUpdateExecutorPin): boolean {
  return left.pluginId === right.pluginId && left.version === right.version
    && left.revision === right.revision && left.entryPath === right.entryPath;
}


export type PlanUpdateExecutorSelection = Readonly<{
  pin?: PlanUpdateExecutorPin;
  descriptor?: PlanUpdateExecutorDescriptor;
  error?: unknown;
}>;
