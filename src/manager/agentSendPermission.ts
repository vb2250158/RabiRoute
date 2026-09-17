import { resolvePrimaryAgentTarget } from "../shared/routeAgentTargets.js";
import { agentAdapterManifest, isPlanAssistantAgentType } from "../shared/agentAdapterCapabilities.js";
import type { AgentAdapterType } from "../shared/agentAdapterCapabilities.js";
import type { AgentSendSender } from "../agentSend.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import type { TrustedLanAgentSource } from "./lanAgentBodyAuthority.js";

/**
 * The plain adapter name for a permission error.
 *
 * Manifest labels are display strings and carry parenthetical descriptions
 * ("Codex（ChatGPT 中的编码 Agent）"), which reads badly inside a sentence. Trim
 * to the leading name so the message stays the short "Codex"/"DSH"/"Antigravity"
 * form callers already match on.
 */
function adapterShortName(agentAdapter: AgentAdapterType): string {
  return agentAdapterManifest(agentAdapter).label.split(/[（(]/)[0]!.trim();
}

/**
 * The local session field that holds the primary persona's session for an
 * adapter. Adding an adapter means adding one row here, instead of extending a
 * binary Codex-or-DSH assumption that silently ignored everyone else.
 */
function primarySessionIdForAdapter(definition: GatewayDefinition, adapter: string): string {
  switch (adapter) {
    case "dsh":
      return String(definition.dshSessionId || "").trim();
    case "antigravity":
      return String(definition.antigravityConversationId || "").trim();
    case "workbuddy":
      return String(definition.workbuddySessionId || "").trim();
    default:
      return String(definition.codexThreadId || "").trim();
  }
}

export function assertAgentSendPermission(
  sender: AgentSendSender,
  definition: GatewayDefinition | undefined,
  remoteSource?: TrustedLanAgentSource
): void {
  const primaryTarget = definition ? resolvePrimaryAgentTarget(definition) : undefined;
  const primaryAdapter = primaryTarget?.provider;
  if (!primaryTarget && definition?.codexHooks?.onlyPrimaryPersonaCanSendMessages === true) throw new Error("Primary Agent target is not configured.");
  if (!isPlanAssistantAgentType(primaryAdapter)
    || definition?.codexHooks?.onlyPrimaryPersonaCanSendMessages !== true) return;

  if (remoteSource) {
    const binding = primaryTarget?.binding;
    if (primaryAdapter === remoteSource.provider
      && binding?.instanceId === remoteSource.nodeId
      && binding.agentId === remoteSource.agentId
      && remoteSource.sessionId
      && sender.sessionId === remoteSource.sessionId
      && sender.agentType === "primary_persona") return;
  } else if (!primaryTarget?.binding) {
    // A local session cannot inherit a remote primary target's authority.
    const primarySessionId = primarySessionIdForAdapter(definition!, primaryAdapter);
    if (sender.agentType === "primary_persona" && primarySessionId && sender.sessionId === primarySessionId) return;
  }

  throw new Error(`Only the configured ${adapterShortName(primaryAdapter)} primary persona session can send messages while this Hook is enabled.`);
}
