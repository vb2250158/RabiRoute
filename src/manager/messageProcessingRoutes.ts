import type { ApiOperationResult } from "./apiOperationContract.js";
import type {
  CriticalProjectFactDisposition,
  KnowledgeMatchCallbackInput,
  KnowledgeRecallMatch,
  MessageProcessingGroupRegistrationResult,
  MessageProcessingOutcomeInput,
  MessageProcessingRequirement,
  RegisterMessageGroupRequirementInput
} from "../messageProcessing/board.js";
import type { MessageProcessingSendContextApproval, MessageProcessingSendContextApprovalInput, MessageProcessingSendContextSnapshot } from "../messageProcessing/sendContextReview.js";
import type { ManagerOperationalLog } from "./operationalLog.js";

export type MessageProcessingRegistrationInput = {
  action?: "register_group" | "dispatch" | "dispatch_failed";
  requirementId?: string;
  messageGroupId?: string;
  source?: RegisterMessageGroupRequirementInput["source"];
  worker?: MessageProcessingRequirement["worker"];
  error?: string;
};

type CriticalFactVerificationInput = {
  roleId?: string;
  requirement?: MessageProcessingRequirement;
  disposition?: CriticalProjectFactDisposition;
};

export type MessageProcessingApiContext = {
  boardPayload: (routeId?: string, limit?: number) => Promise<Record<string, unknown>>;
  board: {
    getRequirement: (requirementId: string) => MessageProcessingRequirement | undefined;
    registerMessageGroup: (input: RegisterMessageGroupRequirementInput) => MessageProcessingGroupRegistrationResult;
    recordDispatch: (
      requirementId: string,
      worker: NonNullable<MessageProcessingRequirement["worker"]>
    ) => MessageProcessingRequirement;
    recordDispatchFailure: (requirementId: string, error: string) => MessageProcessingRequirement;
    submitOutcome: (
      requirementId: string,
      input: MessageProcessingOutcomeInput
    ) => MessageProcessingRequirement;
    recordKnowledgeCallback: (
      requirementId: string,
      input: KnowledgeMatchCallbackInput
    ) => MessageProcessingRequirement;
  };
  sendContextReview: {
    snapshot: (requirementId: string, sourceMessageId?: string) => Promise<MessageProcessingSendContextSnapshot>;
    approve: (
      requirementId: string,
      input: MessageProcessingSendContextApprovalInput
    ) => Promise<MessageProcessingSendContextApproval>;
  };
  operationalLog: Pick<ManagerOperationalLog, "record">;
  recallKnowledge: (source: RegisterMessageGroupRequirementInput["source"]) => KnowledgeRecallMatch[];
  verifyCriticalFactRecord: (input: CriticalFactVerificationInput) => void | Promise<void>;
  setPlanBaseline: (
    requirement: MessageProcessingRequirement,
    roleId?: string,
    planId?: string
  ) => void;
  scheduleKnowledgeCallbackReminder: (requirement: MessageProcessingRequirement) => void;
  publishEvent: (eventType: string, data: unknown) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishBoardChange(
  context: MessageProcessingApiContext,
  requirement: MessageProcessingRequirement
): void {
  context.publishEvent("message_processing_board_changed", {
    requirementId: requirement.id,
    status: requirement.status
  });
}

async function verifyOutcomeRecords(
  context: MessageProcessingApiContext,
  requirement: MessageProcessingRequirement | undefined,
  body: MessageProcessingOutcomeInput
): Promise<void> {
  const roleId = String(body.roleId || requirement?.source.roleId || "").trim() || undefined;
  for (const disposition of body.knowledgeMatchDispositions || []) {
    for (const action of disposition.actions || []) {
      if (!action.recordType || !action.recordId || !action.verifiedAt) continue;
      await context.verifyCriticalFactRecord({
        roleId,
        requirement: requirement
          ? { ...requirement, criticalFacts: [{ kind: "scope", evidence: action.evidence }] }
          : undefined,
        disposition: {
          status: "recorded",
          record: action.recordType === "memory"
            ? { type: "memory", memoryId: action.recordId }
            : { type: "plan", planId: action.recordId },
          evidence: action.evidence,
          verifiedAt: action.verifiedAt
        }
      });
    }
  }
  await context.verifyCriticalFactRecord({
    roleId,
    requirement: requirement && body.projectFactAssessment?.status === "critical"
      ? { ...requirement, criticalFacts: body.projectFactAssessment.facts }
      : requirement,
    disposition: body.criticalFactDisposition
  });
}

/** Original board and review services own all persistence, deduplication and approval state. */
export function createMessageProcessingOwner(context: MessageProcessingApiContext) {
  const success = (data: unknown): ApiOperationResult => ({ status: 200, body: { code: 0, data } });
  const failed = (error: unknown, status = 400): ApiOperationResult => ({ status, body: { code: -1, message: errorMessage(error) } });
  const changed = (id: string, original: MessageProcessingRequirement | undefined) => {
    if (original && context.board.getRequirement(id)?.updatedAt !== original.updatedAt) throw new Error("Message processing requirement changed; retry verification.");
  };
  return Object.freeze({
    async board(routeId?: string, limit = 100): Promise<ApiOperationResult> {
      try { return success(await context.boardPayload(routeId, limit)); } catch (error) { return failed(error, 500); }
    },
    requirement(id: string): ApiOperationResult {
      const item = context.board.getRequirement(id);
      return item ? success(item) : failed(new Error(`Message processing requirement not found: ${id}`), 404);
    },
    async contextSnapshot(id: string, sourceMessageId?: string): Promise<ApiOperationResult> {
      try { return success(await context.sendContextReview.snapshot(id, sourceMessageId)); } catch (error) { return failed(error); }
    },
    async approve(id: string, body: MessageProcessingSendContextApprovalInput): Promise<ApiOperationResult> {
      try {
        const data = await context.sendContextReview.approve(id, body);
        context.operationalLog.record("info", "message_processing_send_context_review_approved", { action: id, result: `expiresAt=${data.expiresAt}` });
        return success(data);
      } catch (error) { return failed(error); }
    },
    register(body: MessageProcessingRegistrationInput): ApiOperationResult {
      try {
        const requirementId = String(body.requirementId || "").trim();
        if (!requirementId) throw new Error("Missing requirementId.");
        if (body.action === "register_group") {
          const registration = context.board.registerMessageGroup({ requirementId, messageGroupId: String(body.messageGroupId || "").trim(), source: body.source as RegisterMessageGroupRequirementInput["source"], knowledgeMatches: context.recallKnowledge(body.source as RegisterMessageGroupRequirementInput["source"]) });
          if (registration.outcome !== "replay_suppressed") { context.scheduleKnowledgeCallbackReminder(registration.requirement); publishBoardChange(context, registration.requirement); }
          return success(registration);
        }
        const item = body.action === "dispatch" ? context.board.recordDispatch(requirementId, body.worker as NonNullable<MessageProcessingRequirement["worker"]>)
          : body.action === "dispatch_failed" ? context.board.recordDispatchFailure(requirementId, body.error || "Message Agent dispatch failed.")
          : (() => { throw new Error("Unsupported message-processing action."); })();
        context.scheduleKnowledgeCallbackReminder(item); publishBoardChange(context, item); return success(item);
      } catch (error) { return failed(error); }
    },
    async outcome(id: string, body: MessageProcessingOutcomeInput, assertOriginalSource: () => void): Promise<ApiOperationResult> {
      try {
        const requirement = context.board.getRequirement(id);
        await verifyOutcomeRecords(context, requirement, body);
        assertOriginalSource(); changed(id, requirement);
        const data = context.board.submitOutcome(id, body);
        context.setPlanBaseline(data, body.roleId, body.planId); context.scheduleKnowledgeCallbackReminder(data); publishBoardChange(context, data);
        return success(data);
      } catch (error) { return failed(error); }
    },
    async callback(id: string, body: KnowledgeMatchCallbackInput, assertOriginalSource: () => void): Promise<ApiOperationResult> {
      try {
        const requirement = context.board.getRequirement(id);
        if (!requirement) throw new Error(`Message processing requirement not found: ${id}`);
        const roleId = String(requirement.source.roleId || "").trim() || undefined;
        if ((body.result === "updated" || body.result === "created") && body.recordType && body.recordId) {
          await context.verifyCriticalFactRecord({ roleId, requirement: { ...requirement, criticalFacts: [{ kind: "scope", evidence: body.evidence }] }, disposition: { status: "recorded", record: body.recordType === "memory" ? { type: "memory", memoryId: body.recordId } : { type: "plan", planId: body.recordId }, evidence: body.evidence, verifiedAt: body.verifiedAt } });
        }
        assertOriginalSource(); changed(id, requirement);
        const data = context.board.recordKnowledgeCallback(id, body);
        context.scheduleKnowledgeCallbackReminder(data); publishBoardChange(context, data); return success(data);
      } catch (error) { return failed(error); }
    }
  });
}
