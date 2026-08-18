import {
  prepareAgentSendRequest,
  type AgentSendRequest,
  type AgentSendResult
} from "./agentSend.js";
import type { AgentReplyOptions, AgentReplyRouteProfile, AgentReplyRuntime } from "./outbox.js";
import { LanguageStyleValidator } from "./languageStyleValidation.js";

export type AgentSendLanguageStyleDecision = {
  blocked: boolean;
  metadata?: NonNullable<AgentSendResult["languageStyleValidation"]>;
};

type ResolvedRoute = {
  runtime: AgentReplyRuntime;
  profile?: AgentReplyRouteProfile;
};

function resolveRoute(runtimes: AgentReplyRuntime[], routeId: string): ResolvedRoute | undefined {
  for (const runtime of runtimes) {
    if (runtime.enabled === false) continue;
    const profile = runtime.routeProfiles?.find(item => item.id === routeId && item.enabled !== false);
    if (profile) return { runtime, profile };
    if (runtime.id === routeId || runtime.configName === routeId) {
      if ((runtime.routeProfiles?.length ?? 0) > 1) return undefined;
      const onlyProfile = runtime.routeProfiles?.[0];
      if (onlyProfile?.enabled === false) return undefined;
      return { runtime, profile: onlyProfile };
    }
  }
  return undefined;
}

export async function evaluateAgentSendLanguageStyle(
  request: AgentSendRequest,
  options: Pick<AgentReplyOptions, "runtimes">,
  validator: LanguageStyleValidator
): Promise<AgentSendLanguageStyleDecision> {
  const prepared = prepareAgentSendRequest(request);
  const route = resolveRoute(options.runtimes, prepared.routeId);
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
  const text = typeof prepared.internal.text === "string" ? prepared.internal.text.trim() : "";
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
