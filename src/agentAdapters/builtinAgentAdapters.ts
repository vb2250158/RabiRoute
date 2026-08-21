import { notifyCodex } from "../codexRuntime.js";
import { notifyCopilotCli } from "../copilotCli.js";
import { notifyMarvis } from "../marvis.js";
import { notifyDshSession } from "../dshSessionBridge.js";
import { renderRabiDelivery } from "../shared/rabiMessage.js";
import {
  agentAdapterTypes,
  agentAdapterManifest,
  type AgentAdapterType
} from "../shared/agentAdapterCapabilities.js";
import { notifyAstrbot } from "./astrbotAdapter.js";
import type { AgentAdapter, AgentAdapterDefinition } from "./contracts.js";

const factories = Object.freeze({
  codex: (): AgentAdapter => ({
    type: "codex",
    deliver: async (envelope, options) => {
      await notifyCodex(renderRabiDelivery(envelope), options?.imagePaths);
    }
  }),
  copilotCli: (): AgentAdapter => ({
    type: "copilotCli",
    deliver: async (envelope) => {
      await notifyCopilotCli(renderRabiDelivery(envelope));
    }
  }),
  marvis: (): AgentAdapter => ({
    type: "marvis",
    deliver: async (envelope) => {
      await notifyMarvis(renderRabiDelivery(envelope));
    }
  }),
  astrbot: (): AgentAdapter => ({
    type: "astrbot",
    deliver: async (envelope) => {
      await notifyAstrbot(renderRabiDelivery(envelope));
    }
  }),
  dsh: (): AgentAdapter => ({
    type: "dsh",
    deliver: async (envelope, options) => {
      await notifyDshSession(renderRabiDelivery(envelope), options?.imagePaths);
    }
  })
}) satisfies Readonly<Record<AgentAdapterType, () => AgentAdapter>>;

export function builtinAgentAdapterDefinitions(): AgentAdapterDefinition[] {
  return agentAdapterTypes.map((type) => ({
    manifest: agentAdapterManifest(type),
    create: factories[type]
  }));
}
