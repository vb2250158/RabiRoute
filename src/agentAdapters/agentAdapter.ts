import { notifyCodex } from "../codexRuntime.js";
import { notifyCopilotCli } from "../copilotCli.js";
import { notifyMarvis } from "../marvis.js";
import { notifyAstrbot } from "./astrbotAdapter.js";
import type { AgentAdapterType } from "./types.js";

export type AgentAdapter = {
  type: AgentAdapterType;
  deliver(message: string): Promise<void>;
};

export function createAgentAdapter(type: AgentAdapterType): AgentAdapter {
  if (type === "codex") {
    return {
      type,
      deliver: async (message) => { await notifyCodex(message); }
    };
  }

  if (type === "copilotCli") {
    return {
      type,
      deliver: notifyCopilotCli
    };
  }

  if (type === "marvis") {
    return {
      type,
      deliver: notifyMarvis
    };
  }

  if (type === "astrbot") {
    return {
      type,
      deliver: notifyAstrbot
    };
  }

  throw new Error(`Unsupported agent adapter: ${type}`);
}
