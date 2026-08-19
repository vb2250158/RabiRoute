import type { MessageProcessingRequirement } from "../messageProcessing/board.js";
import {
  codexMessageProcessingAgentEnabled,
  type GatewayDefinition
} from "../shared/gatewayConfigModel.js";

export type MessageProcessingDeliveryAgentType = "message_processing" | "primary_persona";

export type MessageProcessingDeliveryTarget = {
  agentType: MessageProcessingDeliveryAgentType;
  worker: NonNullable<MessageProcessingRequirement["worker"]>;
};

export type ResolvedMessageProcessingDeliveryTarget = {
  target: MessageProcessingDeliveryTarget;
  previousThreadId?: string;
};

function configuredPrimaryAgentAdapter(definition: GatewayDefinition): string | undefined {
  return definition.primaryAgentAdapter || definition.agentAdapters?.[0];
}

function primaryPersonaWorker(
  definition: GatewayDefinition
): NonNullable<MessageProcessingRequirement["worker"]> | undefined {
  const adapter = configuredPrimaryAgentAdapter(definition);
  if (adapter === "dsh") {
    const sessionId = definition.dshSessionId?.trim();
    const workspace = definition.dshCwd?.trim();
    if (!sessionId || !workspace) return undefined;
    return {
      threadId: sessionId,
      threadName: definition.dshSessionName?.trim() || "DSH 主人格",
      workspace
    };
  }
  if (adapter !== "codex") return undefined;
  const threadId = definition.codexThreadId?.trim();
  const workspace = definition.codexCwd?.trim();
  if (!threadId || !workspace) return undefined;
  return {
    threadId,
    threadName: definition.codexThreadName?.trim() || "Codex 主人格",
    workspace
  };
}

export function resolveMessageProcessingDeliveryTarget(
  definition: GatewayDefinition,
  managedWorker: MessageProcessingRequirement["worker"]
): MessageProcessingDeliveryTarget | undefined {
  if (codexMessageProcessingAgentEnabled(definition)) {
    return managedWorker
      ? { agentType: "message_processing", worker: managedWorker }
      : undefined;
  }
  const worker = primaryPersonaWorker(definition);
  return worker ? { agentType: "primary_persona", worker } : undefined;
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
      agentType: target.agentType,
      worker: {
        threadId,
        threadName: String(thread?.title || target.worker.threadName),
        workspace: String(thread?.cwd || target.worker.workspace)
      }
    }
  };
}
