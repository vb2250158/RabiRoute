import type { AgentSendSender } from "../agentSend.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

export function assertAgentSendPermission(sender: AgentSendSender, definition: GatewayDefinition | undefined): void {
  const primaryAdapter = definition?.primaryAgentAdapter || definition?.agentAdapters?.[0];
  if ((primaryAdapter !== "codex" && primaryAdapter !== "dsh")
    || definition?.codexHooks?.onlyPrimaryPersonaCanSendMessages !== true) return;

  const primarySessionId = String(primaryAdapter === "dsh" ? definition.dshSessionId : definition.codexThreadId).trim();
  if (sender.agentType === "primary_persona" && primarySessionId && sender.sessionId === primarySessionId) return;

  throw new Error(`Only the configured ${primaryAdapter === "dsh" ? "DSH" : "Codex"} primary persona session can send messages while this Hook is enabled.`);
}
