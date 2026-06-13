import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { createHeartbeatAdapter } from "./adapters/heartbeatAdapter.js";
import { createNapCatAdapter } from "./adapters/napcatAdapter.js";
import { createFenneNoteAdapter, createWebhookAdapter, createXiaoAiAdapter } from "./adapters/webhookAdapter.js";
import { createAgentAdapter } from "./agentAdapters/agentAdapter.js";
import type { MessageAdapter, MessageAdapterType } from "./adapters/messageAdapter.js";
import { triggerManualRule } from "./manualTrigger.js";
import { forwardMessageAndWait, type ForwardDeliveryResult } from "./forwarding.js";
import type { RolePanelMessageRecord } from "./history.js";

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

function deliverySummary(result: ForwardDeliveryResult): string {
  const failedAdapters = result.adapterOutcomes.filter((outcome) => outcome.status === "failed").length;
  const deliveredAdapters = result.adapterOutcomes.filter((outcome) => outcome.status === "delivered").length;
  const reason = result.reason ? ` reason=${result.reason}` : "";
  return `status=${result.status} matched=${result.matchedRuleCount} packets=${result.sentPacketCount} adapters=${deliveredAdapters}/${result.adapterOutcomes.length} failed=${failedAdapters}${reason}`;
}

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
  const triggerRuleId = ruleArg ? ruleArg.slice("--manual-rule=".length).trim() || undefined : routeKind === "heartbeat" ? undefined : triggerId;
  try {
    const result = await triggerManualRule(triggerId, message, triggerName, routeKind, triggerRuleId);
    const summary = deliverySummary(result);
    if (result.status === "failed") {
      console.error(`RabiRoute manual trigger failed: ${triggerId} ${summary}`);
      process.exit(1);
    }
    console.log(`RabiRoute manual trigger completed: ${triggerId} ${summary}`);
    process.exit(0);
  } catch (error) {
    console.error(`RabiRoute manual trigger failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const rolePanelMessageArg = process.argv.find((arg) => arg.startsWith("--role-panel-message="));
if (rolePanelMessageArg) {
  const messageId = rolePanelMessageArg.slice("--role-panel-message=".length).trim() || `role-panel-${Date.now()}`;
  const messageArg = process.argv.find((arg) => arg.startsWith("--role-panel-text="));
  const roleArg = process.argv.find((arg) => arg.startsWith("--role-panel-role="));
  const gatewayArg = process.argv.find((arg) => arg.startsWith("--role-panel-gateway="));
  const profileArg = process.argv.find((arg) => arg.startsWith("--role-panel-route-profile="));
  const attachmentArg = process.argv.find((arg) => arg.startsWith("--role-panel-attachments="));
  const text = messageArg ? decodeURIComponent(messageArg.slice("--role-panel-text=".length)) : "";
  const roleId = roleArg ? decodeURIComponent(roleArg.slice("--role-panel-role=".length)) : config.agentRoleId;
  const gatewayId = gatewayArg ? decodeURIComponent(gatewayArg.slice("--role-panel-gateway=".length)) : process.env.GATEWAY_ID;
  const routeProfileId = profileArg ? decodeURIComponent(profileArg.slice("--role-panel-route-profile=".length)) : undefined;
  let attachments: unknown[] = [];
  if (attachmentArg) {
    try {
      const parsed = JSON.parse(decodeURIComponent(attachmentArg.slice("--role-panel-attachments=".length))) as unknown;
      attachments = Array.isArray(parsed) ? parsed : [];
    } catch {
      attachments = [];
    }
  }
  const record: RolePanelMessageRecord = {
    time: Math.floor(Date.now() / 1000),
    rawMessage: text,
    messageId,
    senderName: roleId ? `${roleId} 角色面板` : "角色面板",
    roleId,
    gatewayId,
    routeProfileId,
    attachments,
    adapterType: "rolePanel"
  };
  try {
    const result = await forwardMessageAndWait("role_panel_message", record);
    const summary = deliverySummary(result);
    if (result.status === "failed") {
      console.error(`RabiRoute role panel message failed: ${messageId} ${summary}`);
      process.exit(1);
    }
    if (result.status === "missed" || result.status === "routed" || result.status === "skipped") {
      console.warn(`RabiRoute role panel message not delivered: ${messageId} ${summary}`);
    } else {
      console.log(`RabiRoute role panel message delivered: ${messageId} ${summary}`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`RabiRoute role panel message failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const directAgentMessageArg = process.argv.find((arg) => arg.startsWith("--direct-agent-message="));
if (directAgentMessageArg) {
  const message = decodeURIComponent(directAgentMessageArg.slice("--direct-agent-message=".length));
  const adapters = config.agentAdapters.length > 0
    ? config.agentAdapters
    : config.codexDesktopIpcNotify || config.codexDirectNotify
      ? ["codex" as const]
      : [];
  if (adapters.length === 0) {
    console.error("RabiRoute direct agent message failed: no agent adapters configured");
    process.exit(1);
  }
  try {
    await Promise.all(adapters.map((adapter) => createAgentAdapter(adapter).deliver(message)));
    console.log("RabiRoute direct agent message completed");
    process.exit(0);
  } catch (error) {
    console.error(`RabiRoute direct agent message failed: ${error instanceof Error ? error.message : String(error)}`);
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
      const status = type === "disabled" ? "disabled" : type === "rolePanel" ? "running" : "placeholder";
      const message = type === "disabled"
        ? "消息适配端已禁用。"
        : type === "rolePanel"
          ? "角色面板是 RabiRoute 内置本地消息端，由 manager/托盘窗口提供入口。"
        : type === "remoteAgent"
          ? "远端 Agent 消息端由 manager 的 /api/remote-agent 与 WebSocket bridge 提供入口；gateway 子进程不单独监听。"
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
