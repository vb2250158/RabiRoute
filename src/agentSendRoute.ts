import type { AgentReplyRouteProfile, AgentReplyRuntime } from "./outbox.js";

export type AgentSendRoute = { runtime: AgentReplyRuntime; profile?: AgentReplyRouteProfile };

export function resolveAgentSendRoute(runtimes: AgentReplyRuntime[], routeId: string): AgentSendRoute | undefined {
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
