import { CodexDesktopIpcClient } from "../../apps/rabi-agent/lib/codex-desktop-ipc.mjs";
import type { AgentAdapterInvocation } from "@rabiroute/plugin-sdk";
import type { AgentManagerHostPorts } from "../manager/agentManagerHostPorts.js";

/** Own the portable client's protocol and subscription; task IDs and receipts remain on the node. */
export class CodexRemoteTaskOwner {
  private client?: CodexDesktopIpcClient;
  constructor(private readonly host: AgentManagerHostPorts) {}
  async execute(payload: { threadId: string; prompt: string; cwd: string; model?: string; reasoningEffort?: string }, invocation?: AgentAdapterInvocation): Promise<void> {
    invocation?.assertCurrent?.();
    this.client ??= new CodexDesktopIpcClient({
      timeout: invocation?.timeout as ((key: string, fallback: number) => number) | undefined,
      onBroadcast: raw => {
        const event = raw as { method?: string; params?: { conversationId?: string; threadId?: string; change?: unknown } };
        if (event?.method !== "thread-stream-state-changed") return;
        const params = event.params ?? {};
        const sessionId = String(params.conversationId || params.threadId || "").trim();
        const state = JSON.stringify(params.change ?? params);
        const status = state.includes('"status":"completed"') || state.includes('"threadRuntimeStatus":{"type":"idle"') ? "completed"
          : state.includes('"status":"failed"') || state.includes('"status":"interrupted"') ? "failed" : undefined;
        if (status) this.host.publishManagerEvent("agent.task-state", { provider: "codex", sessionId, status });
      }
    });
    await this.client.startTurn(payload);
  }
  dispose(): void { this.client?.close(); this.client = undefined; }
}
