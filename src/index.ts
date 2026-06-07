import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { createHeartbeatAdapter } from "./adapters/heartbeatAdapter.js";
import { createNapCatAdapter } from "./adapters/napcatAdapter.js";
import { createFenneNoteAdapter, createWebhookAdapter, createXiaoAiAdapter } from "./adapters/webhookAdapter.js";
import type { MessageAdapter, MessageAdapterType } from "./adapters/messageAdapter.js";
import { triggerManualRule } from "./manualTrigger.js";

type GatewayStatus = {
  messageAdapter?: {
    type?: MessageAdapterType;
    status?: "running" | "placeholder" | "disabled" | "error";
    message?: string;
    updatedAt?: string;
  };
  messageAdapters?: Record<string, {
    type?: MessageAdapterType;
    status?: "running" | "placeholder" | "disabled" | "error";
    message?: string;
    updatedAt?: string;
  }>;
};

const statusPath = path.join(config.dataDir, "gateway-status.json");

const manualTriggerArg = process.argv.find((arg) => arg.startsWith("--manual-trigger="));
if (manualTriggerArg) {
  const triggerId = manualTriggerArg.slice("--manual-trigger=".length).trim() || "manual";
  const messageArg = process.argv.find((arg) => arg.startsWith("--manual-message="));
  const nameArg = process.argv.find((arg) => arg.startsWith("--manual-name="));
  const routeKindArg = process.argv.find((arg) => arg.startsWith("--manual-route-kind="));
  const ruleArg = process.argv.find((arg) => arg.startsWith("--manual-rule="));
  const message = messageArg ? decodeURIComponent(messageArg.slice("--manual-message=".length)) : triggerId;
  const triggerName = nameArg ? decodeURIComponent(nameArg.slice("--manual-name=".length)) : triggerId;
  const routeKind = routeKindArg?.slice("--manual-route-kind=".length) === "heartbeat" ? "heartbeat" : "manual_trigger";
  const triggerRuleId = ruleArg?.slice("--manual-rule=".length).trim() || triggerId;
  try {
    await triggerManualRule(triggerId, message, triggerName, routeKind, triggerRuleId);
    console.log(`RabiRoute manual trigger completed: ${triggerId}`);
    process.exit(0);
  } catch (error) {
    console.error(`RabiRoute manual trigger failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function readGatewayStatus(): GatewayStatus {
  if (!fs.existsSync(statusPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus;
  } catch {
    return {};
  }
}

function patchMessageAdapterStatus(patch: NonNullable<GatewayStatus["messageAdapter"]>): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const status = readGatewayStatus();
  const type = patch.type ?? status.messageAdapter?.type ?? "disabled";
  fs.writeFileSync(statusPath, JSON.stringify({
    ...status,
    messageAdapter: {
      ...status.messageAdapter,
      ...patch,
      updatedAt: new Date().toISOString()
    },
    messageAdapters: {
      ...status.messageAdapters,
      [type]: {
        ...status.messageAdapters?.[type],
        ...patch,
        updatedAt: new Date().toISOString()
      }
    }
  }, null, 2), "utf8");
}

function createPlaceholderAdapter(type: Exclude<MessageAdapterType, "napcat" | "fennenote" | "xiaoai" | "webhook">): MessageAdapter {
  return {
    type,
    start() {
      const status = type === "disabled" ? "disabled" : "placeholder";
      const message = type === "disabled"
        ? "消息适配端已禁用。"
        : `${type} 消息适配端尚未实现，当前仅作为框架占位。`;
      patchMessageAdapterStatus({ type, status, message });
      console.log(message);
      setInterval(() => {
        patchMessageAdapterStatus({ type, status, message });
      }, 30_000).unref();
    }
  };
}

function createMessageAdapter(): MessageAdapter {
  if (config.messageAdapterType === "napcat") {
    return createNapCatAdapter();
  }
  if (config.messageAdapterType === "heartbeat") {
    return createHeartbeatAdapter();
  }
  if (config.messageAdapterType === "fennenote") {
    return createFenneNoteAdapter();
  }
  if (config.messageAdapterType === "xiaoai") {
    return createXiaoAiAdapter();
  }
  if (config.messageAdapterType === "webhook") {
    return createWebhookAdapter();
  }

  return createPlaceholderAdapter(config.messageAdapterType);
}

function createMessageAdapterByType(type: MessageAdapterType): MessageAdapter {
  if (type === "napcat") {
    return createNapCatAdapter();
  }
  if (type === "heartbeat") {
    return createHeartbeatAdapter();
  }
  if (type === "fennenote") {
    return createFenneNoteAdapter();
  }
  if (type === "xiaoai") {
    return createXiaoAiAdapter();
  }
  if (type === "webhook") {
    return createWebhookAdapter();
  }
  return createPlaceholderAdapter(type);
}

const adapters = config.messageAdapterTypes.length > 0
  ? config.messageAdapterTypes.map(createMessageAdapterByType)
  : [createMessageAdapter()];

for (const adapter of adapters) {
  patchMessageAdapterStatus({
    type: adapter.type,
    status: "running",
    message: `Starting ${adapter.type} message adapter.`
  });
  void adapter.start();
}
