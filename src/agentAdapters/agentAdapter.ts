import { notifyCodex } from "../codexApp.js";
import { notifyCodexDesktop } from "../codexDesktopIpc.js";
import type { AgentAdapterType } from "./types.js";

export type AgentAdapter = {
  type: AgentAdapterType;
  deliver(message: string): Promise<void>;
};

export function createAgentAdapter(type: AgentAdapterType): AgentAdapter {
  if (type === "codexDesktop") {
    return {
      type,
      deliver: notifyCodexDesktop
    };
  }

  return {
    type,
    deliver: notifyCodex
  };
}
