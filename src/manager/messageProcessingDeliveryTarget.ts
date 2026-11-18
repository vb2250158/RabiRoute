import { resolvePrimaryAgentTarget, type AgentTargetSession } from "../shared/routeAgentTargets.js";
import type { AgentInstanceBinding } from "../shared/agentInstance.js";
import type { MessageProcessingRequirement } from "../messageProcessing/board.js";
import { sameCodexWorkspace } from "../codexTaskIdentity.js";
import {
  primaryMessageProcessingAgentAdapter,
  type GatewayDefinition
} from "../shared/gatewayConfigModel.js";

export type MessageProcessingDeliveryAgentType = "message_processing" | "primary_persona";

export type MessageProcessingDeliveryTarget = {
  agentType: MessageProcessingDeliveryAgentType;
  worker: NonNullable<MessageProcessingRequirement["worker"]>;
  instanceBinding?: AgentInstanceBinding;
};

export type ResolvedMessageProcessingDeliveryTarget = {
  target: MessageProcessingDeliveryTarget;
  previousThreadId?: string;
};

export function resolveMessageProcessingDeliveryTarget(
  definition: GatewayDefinition,
  managedWorker: MessageProcessingRequirement["worker"],
  localSession: (definition: GatewayDefinition, agentAdapter: string) => AgentTargetSession | undefined
): MessageProcessingDeliveryTarget | undefined {
  const primary = resolvePrimaryAgentTarget(definition);
  if (!primary) return undefined;
  const instanceBinding = primary.binding;
  const session = instanceBinding ? primary : localSession(definition, primary.provider);
  const threadId = session?.sessionId?.trim();
  const workspace = session?.workspace?.trim();
  if (!threadId || !workspace) return undefined;
  const owner = instanceBinding ? { instanceBinding } : {};
  const managedAdapter = primaryMessageProcessingAgentAdapter(definition);
  if (managedAdapter && managedWorker && messageProcessingWorkerAdapter(managedWorker) === managedAdapter
    && managedWorker.threadId !== threadId) {
    return sameCodexWorkspace(managedWorker.workspace, workspace)
      ? { agentType: "message_processing", worker: { ...managedWorker, agentAdapter: managedAdapter }, ...owner }
      : undefined;
  }
  return {
    agentType: "primary_persona", ...owner,
    worker: { agentAdapter: primary.provider, threadId, threadName: session?.sessionName?.trim() || threadId, workspace }
  };
}

export function messageProcessingWorkerAdapter(worker: Pick<MessageProcessingDeliveryTarget["worker"], "agentAdapter" | "threadId">): string {
  return worker.agentAdapter ?? (worker.threadId.startsWith("session-") ? "dsh" : "codex");
}

export function resolveDeliveredMessageProcessingTarget(
  target: MessageProcessingDeliveryTarget,
  result: Record<string, unknown>
): ResolvedMessageProcessingDeliveryTarget {
  const previousThreadId = String(result.previousThreadId || "").trim();
  const thread = result.thread && typeof result.thread === "object"
    ? result.thread as { id?: unknown; title?: unknown; cwd?: unknown }
    : undefined;
  const threadId = String(thread?.id || result.threadId || "").trim();
  if (!previousThreadId || previousThreadId !== target.worker.threadId || !threadId || threadId === previousThreadId) {
    return { target };
  }
  return {
    previousThreadId,
    target: {
      ...target,
      worker: {
        agentAdapter: target.worker.agentAdapter,
        threadId,
        threadName: String(thread?.title || target.worker.threadName),
        workspace: String(thread?.cwd || target.worker.workspace)
      }
    }
  };
}
