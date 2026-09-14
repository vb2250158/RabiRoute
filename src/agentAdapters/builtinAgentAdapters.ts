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
  }),
  // Discovery for WorkBuddy is implemented (src/workbuddySessionStore.ts), but
  // delivery is not: the gateway credential acquisition path and the
  // desktop-visibility contract are still open. Fail closed rather than open a
  // second execution path. See docs/workbuddy-agent-adapter-plan.md.
  workbuddy: (): AgentAdapter => ({
    type: "workbuddy",
    deliver: async () => {
      throw new Error(
        "WorkBuddy 投递尚未实现：网关凭据获取与桌面可见性合同未验收，按设计门要求失败关闭。"
      );
    }
  })
}) satisfies Readonly<Record<AgentAdapterType, () => AgentAdapter>>;

export function builtinAgentAdapterDefinitions(): AgentAdapterDefinition[] {
  return agentAdapterTypes.map((type) => ({
    manifest: agentAdapterManifest(type),
    create: factories[type]
  }));
}
