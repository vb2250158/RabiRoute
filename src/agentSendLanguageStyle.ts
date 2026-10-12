import {
  prepareAgentSendRequest,
  type AgentSendRequest,
  type AgentSendResult
} from "./agentSend.js";
import type { AgentReplyOptions } from "./outbox.js";
import { resolveAgentSendRoute, type AgentSendRoute } from "./agentSendRoute.js";
import { LanguageStyleValidator } from "./languageStyleValidation.js";

export type AgentSendLanguageStyleDecision = {
  blocked: boolean;
  metadata?: NonNullable<AgentSendResult["languageStyleValidation"]>;
};

export type AgentSendLanguageStyleRoute = AgentSendRoute;

export async function evaluateAgentSendLanguageStyle(
  request: AgentSendRequest,
  options: Pick<AgentReplyOptions, "runtimes"> & {
    remoteLanguageStyle?(route: AgentSendLanguageStyleRoute, text: string, mode: 0 | 1): Promise<AgentSendLanguageStyleDecision>;
  },
  validator: LanguageStyleValidator
): Promise<AgentSendLanguageStyleDecision> {
  const prepared = prepareAgentSendRequest(request);
  const route = resolveAgentSendRoute(options.runtimes, prepared.routeId);
  const text = typeof prepared.internal.text === "string" ? prepared.internal.text.trim() : "";
  if (route && (route.profile?.agentRoleDeviceId ?? route.runtime.agentRoleDeviceId)) {
    if (!options.remoteLanguageStyle) throw new Error("Remote persona language style requires its owning Manager.");
    return options.remoteLanguageStyle(route, text, prepared.styleValidation);
  }
  const binding = route?.profile?.languageStyle ?? route?.runtime.languageStyle;
  if (!binding) return { blocked: false };
  if (prepared.styleValidation === 0) {
    return {
      blocked: false,
      metadata: {
        mode: 0,
        bypassed: true,
        styleSkillUrl: binding.styleSkillUrl
      }
    };
  }
  if (!text) return { blocked: false };
  const result = await validator.validate({
    text,
    styleSkillUrl: binding.styleSkillUrl,
    scope: "outbound_message"
  });
  return {
    blocked: !result.passed,
    metadata: {
      mode: 1,
      bypassed: false,
      styleSkillUrl: binding.styleSkillUrl,
      result
    }
  };
}
