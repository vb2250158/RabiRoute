import { agentNativeFunction, invokeScopedAgentManagerOperation } from "./managerInvocation.js";
import type { CodexNativeOperations, CodexSessionThread, CodexSessionResolution, CodexSessionResolverDependencies } from "./codexContracts.js";
export type { CodexIdleNotificationResult, CodexNotificationTurnOptions, CodexMonitorThread, CodexSessionResolution } from "./codexContracts.js";

export const readCodexThread = agentNativeFunction<CodexNativeOperations["readCodexThread"]>("codex", "readCodexThread");
export const openCodexDesktopThread = agentNativeFunction<CodexNativeOperations["openCodexDesktopThread"]>("codex", "openCodexDesktopThread");
export const notifyCodex = agentNativeFunction<CodexNativeOperations["notifyCodex"]>("codex", "notifyCodex");
export const notifyCodexWhenIdle = agentNativeFunction<CodexNativeOperations["notifyCodexWhenIdle"]>("codex", "notifyCodexWhenIdle");

/** Keep original in-process callbacks and the creation scope on the installed Codex owner. */
export function resolveCodexSession<TThread extends CodexSessionThread>(
  params: { threadId?: string; title: string; cwd: string; createIfMissing: boolean },
  dependencies: CodexSessionResolverDependencies<TThread>
): Promise<CodexSessionResolution<TThread>> {
  return invokeScopedAgentManagerOperation("codex", "native.resolveCodexSession", {}, { nativeArgs: [params, dependencies] });
}
