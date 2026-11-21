import type { CodexHookContextRequest, CodexHookContextResult } from "@rabiroute/host-api/manager/codexHookContext";
import { normalizePathForComparison } from "@rabiroute/host-api/shared/pathPolicy";
import { desktopPetWorkKey, desktopPetWorkSessionKey } from "@rabiroute/host-api/shared/desktopPetWorkIdentity";

type HookResult = Pick<CodexHookContextResult, "action" | "binding" | "followup" | "completionDeferred" | "toolDecision" | "additionalContext">;
type HookSource = Pick<CodexHookContextRequest, "agentType" | "sessionId" | "sourceInstance">;

export function desktopPetWorkDetached(request: HookSource, roleId: string) {
  return { roleId, sessionKey: desktopPetWorkSessionKey(request), phase: "detached" };
}

function toolActivity(name: string): string {
  const shortName = name.toLowerCase().split("__").at(-1) ?? "";
  if (/^(ask_user_question|request_user_input|request_human_input)$/.test(shortName)) return "waiting";
  if (/^(exec_command|write_stdin|bash|powershell|shell|terminal)$/.test(shortName)) return "command";
  if (/^(apply_patch|edit|write|write_file|replace)$/.test(shortName)) return "editing";
  if (/^(read|read_file|search|grep|glob|search_query|web_search)$/.test(shortName)) return "reading";
  return "tool";
}

/** Derive a screen-safe animation cue from an accepted, persona-bound hook. */
export function desktopPetWorkEvent(request: CodexHookContextRequest, result: HookResult) {
  const { binding } = result;
  if (!binding || binding.cwd && request.cwd
    && normalizePathForComparison(binding.cwd) !== normalizePathForComparison(request.cwd)) return;
  if (!request.sessionId.trim() || !request.turnId?.trim() || result.action !== "none") return;
  const sessionKey = desktopPetWorkSessionKey(request);
  const cue = { roleId: binding.roleId, sessionKey, turnKey: desktopPetWorkKey(sessionKey, request.turnId) };
  switch (request.eventName) {
    case "UserPromptSubmit":
      return { ...cue, phase: "thinking" };
    case "PreToolUse": {
      if (result.toolDecision?.permissionDecision === "deny") return;
      const activity = toolActivity(request.toolName ?? "");
      return { ...cue, phase: activity === "waiting" ? "waiting" : "working", activity,
        toolKey: request.toolUseId ? desktopPetWorkKey(sessionKey, request.toolUseId) : "" };
    }
    case "PostToolUse":
      return { ...cue, phase: "reviewing",
        toolKey: request.toolUseId ? desktopPetWorkKey(sessionKey, request.toolUseId) : "" };
    case "Stop":
      if (result.followup || result.completionDeferred || result.additionalContext?.trim()) {
        return { ...cue, phase: "thinking", clearTools: true };
      }
      return { ...cue, phase: request.lastAssistantMessage?.trim() ? "completed" : "cleared" };
  }
}
