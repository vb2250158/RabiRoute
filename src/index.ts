import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { createNapCatAdapter } from "./adapters/napcatAdapter.js";
import type { MessageAdapter, MessageAdapterType } from "./adapters/messageAdapter.js";

type GatewayStatus = {
  messageAdapter?: {
    type?: MessageAdapterType;
    status?: "running" | "placeholder" | "disabled" | "error";
    message?: string;
    updatedAt?: string;
  };
};

const statusPath = path.join(config.dataDir, "gateway-status.json");

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
  fs.writeFileSync(statusPath, JSON.stringify({
    ...status,
    messageAdapter: {
      ...status.messageAdapter,
      ...patch,
      updatedAt: new Date().toISOString()
    }
  }, null, 2), "utf8");
}

function createPlaceholderAdapter(type: Exclude<MessageAdapterType, "napcat">): MessageAdapter {
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

  return createPlaceholderAdapter(config.messageAdapterType);
}

const adapter = createMessageAdapter();
patchMessageAdapterStatus({
  type: adapter.type,
  status: "running",
  message: `Starting ${adapter.type} message adapter.`
});
void adapter.start();
