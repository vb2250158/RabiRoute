import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessage } from "../forwarding.js";
import { appendHeartbeatEvent, type HeartbeatEventRecord } from "../history.js";
import type { MessageAdapter } from "./messageAdapter.js";

type GatewayStatus = {
  messageAdapters?: Record<string, {
    status?: "running" | "error";
    message?: string;
    updatedAt?: string;
    intervalSeconds?: number;
    lastTickAt?: string;
    tickCount?: number;
  }>;
  messageAdapter?: {
    type?: string;
    status?: string;
    message?: string;
    updatedAt?: string;
  };
  heartbeat?: {
    enabled?: boolean;
    intervalSeconds?: number;
    message?: string;
    lastTickAt?: string;
    tickCount?: number;
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

function writeGatewayStatus(nextStatus: GatewayStatus): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify(nextStatus, null, 2), "utf8");
}

function patchHeartbeatStatus(patch: NonNullable<GatewayStatus["heartbeat"]>): void {
  const status = readGatewayStatus();
  const current = status.messageAdapters?.heartbeat ?? {};
  writeGatewayStatus({
    ...status,
    messageAdapters: {
      ...status.messageAdapters,
      heartbeat: {
        ...current,
        status: "running",
        updatedAt: new Date().toISOString(),
        ...patch
      }
    },
    heartbeat: {
      ...status.heartbeat,
      ...patch
    }
  });
}

function tickHeartbeat(): void {
  const now = Math.floor(Date.now() / 1000);
  const status = readGatewayStatus().heartbeat;
  const record: HeartbeatEventRecord = {
    time: now,
    rawMessage: config.heartbeatMessage,
    messageId: `heartbeat-${now}`,
    senderName: "RabiRoute 心跳",
    intervalSeconds: config.heartbeatIntervalSeconds
  };

  appendHeartbeatEvent(record);
  const tickCount = (status?.tickCount ?? 0) + 1;
  patchHeartbeatStatus({
    enabled: true,
    intervalSeconds: config.heartbeatIntervalSeconds,
    message: config.heartbeatMessage,
    lastTickAt: new Date().toISOString(),
    tickCount
  });
  forwardMessage("heartbeat", record);
}

export function createHeartbeatAdapter(): MessageAdapter {
  return {
    type: "heartbeat",
    start() {
      patchHeartbeatStatus({
        enabled: true,
        intervalSeconds: config.heartbeatIntervalSeconds,
        message: config.heartbeatMessage
      });
      console.log(`RabiRoute heartbeat adapter enabled, interval=${config.heartbeatIntervalSeconds}s`);
      setInterval(tickHeartbeat, config.heartbeatIntervalSeconds * 1000);
    }
  };
}
