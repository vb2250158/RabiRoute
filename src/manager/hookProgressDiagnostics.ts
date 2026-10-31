import { currentOperationContext } from "../observability/dataMutationAudit.js";
import type { CodexHookContextServiceOptions } from "./codexHookContext.js";
import type { ManagerOperationalLog } from "./operationalLog.js";

/** Preserve the HTTP request identity when writing content-free Stop stage records. */
export function createStopStageObserver(log: ManagerOperationalLog): NonNullable<CodexHookContextServiceOptions["onHookStage"]> {
  return (request, stage) => {
    log.record(stage.phase === "failed" ? "warn" : "info", "agent_hook_stop_stage", {
      ...currentOperationContext(),
      hookProgress: { sessionId: request.sessionId, turnId: request.turnId, stage: stage.name, phase: stage.phase, startMs: stage.startMs },
      ...(stage.durationMs === undefined ? {} : { durationMs: stage.durationMs })
    });
  };
}
