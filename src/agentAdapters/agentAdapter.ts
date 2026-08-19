import { notifyCodex } from "../codexRuntime.js";
import { notifyCopilotCli } from "../copilotCli.js";
import { notifyMarvis } from "../marvis.js";
import { notifyAstrbot } from "./astrbotAdapter.js";
import { notifyDshSession } from "../dshSessionBridge.js";
import type { AgentAdapterType } from "./types.js";

export type AgentAdapter = {
  type: AgentAdapterType;
  deliver(message: string, options?: AgentDeliveryOptions): Promise<void>;
};

export type AgentDeliveryOptions = {
  imagePaths?: string[];
};

export function createAgentAdapter(type: AgentAdapterType): AgentAdapter {
  if (type === "codex") {
    return {
      type,
      deliver: async (message, options) => { await notifyCodex(message, options?.imagePaths); }
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

  if (type === "dsh") {
    return {
      type,
      deliver: async (message, options) => {
        await notifyDshSession(message, options?.imagePaths);
      }
    };
  }

  throw new Error(`Unsupported agent adapter: ${type}`);
}
