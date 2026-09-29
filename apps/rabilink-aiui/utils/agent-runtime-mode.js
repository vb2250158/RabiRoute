export const AGENT_RUNTIME_MODES = Object.freeze({ LOCAL: "local-aiui", REMOTE: "legacy-remote-observer" });
// Credentials authorize HTTP capabilities; they never select the inference owner.
export function resolveAgentRuntimeMode(value) {
  return value === AGENT_RUNTIME_MODES.REMOTE ? AGENT_RUNTIME_MODES.REMOTE : AGENT_RUNTIME_MODES.LOCAL;
}
export function usesRemoteAgent(mode) { return mode === AGENT_RUNTIME_MODES.REMOTE; }
export function agentTurnDestination(mode, token) {
  if (!usesRemoteAgent(mode)) return "local";
  return typeof token === "string" && token.trim() && token !== "standalone" && token !== "mobile-bound" ? "remote" : "unavailable";
}
