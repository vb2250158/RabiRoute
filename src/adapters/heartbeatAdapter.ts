import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessageAndWait, type ForwardDeliveryResult } from "../forwarding.js";
import { appendAdapterLog, appendHeartbeatEvent, type HeartbeatEventRecord } from "../history.js";
import {
  collectHeartbeatScheduleTasks,
  heartbeatScheduleLabel,
  nextHeartbeatScheduleTime,
  type HeartbeatScheduleTask
} from "../scheduling/heartbeatSchedules.js";
import type { MessageAdapter } from "./messageAdapter.js";

type GatewayStatus = {
  messageAdapters?: Record<string, {
    status?: "running" | "error";
    message?: string;
    updatedAt?: string;
    intervalSeconds?: number;
    lastTickAt?: string;
    tickCount?: number;
    scheduleCount?: number;
    nextTickAt?: string;
    lastDeliveryAt?: string;
    lastDeliveryStatus?: string;
    lastDeliveryMessageId?: string;
    lastDeliveryMatchedRuleCount?: number;
    lastDeliverySentPacketCount?: number;
    lastDeliveryError?: string;
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
    scheduleCount?: number;
    nextTickAt?: string;
    lastScheduleId?: string;
    lastScheduleName?: string;
    lastDeliveryAt?: string;
    lastDeliveryStatus?: string;
    lastDeliveryMessageId?: string;
    lastDeliveryMatchedRuleCount?: number;
    lastDeliverySentPacketCount?: number;
    lastDeliveryError?: string;
  };
};

type RunningHeartbeatTask = HeartbeatScheduleTask & {
  nextAt?: Date;
  timer?: NodeJS.Timeout;
};

const maxTimeoutMs = 2_147_483_647;
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

function activeRouteProfiles() {
  return config.routeProfiles.filter((route) => route.enabled !== false);
}

function minNextTick(tasks: RunningHeartbeatTask[]): string | undefined {
  const next = tasks
    .map((task) => task.nextAt)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => left.getTime() - right.getTime())[0];
  return next?.toISOString();
}

function patchScheduleSummary(tasks: RunningHeartbeatTask[]): void {
  patchHeartbeatStatus({
    enabled: true,
    scheduleCount: tasks.length,
    nextTickAt: minNextTick(tasks)
  });
}

function scheduleMessage(task: RunningHeartbeatTask): string {
  if (task.schedule.id === "legacy-interval") {
    return config.heartbeatMessage;
  }
  return `定时计划触发：${heartbeatScheduleLabel(task)}`;
}

function deliveryLogLevel(result: ForwardDeliveryResult): "info" | "warning" | "error" {
  if (result.status === "failed") {
    return "error";
  }
  if (result.status === "missed" || result.status === "skipped") {
    return "warning";
  }
  return "info";
}

function recordHeartbeatDelivery(record: HeartbeatEventRecord, result: ForwardDeliveryResult): void {
  appendAdapterLog("heartbeat", {
    event: "delivery_result",
    level: deliveryLogLevel(result),
    message: `Heartbeat delivery ${result.status} messageId=${record.messageId} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`,
    data: result
  });
  patchHeartbeatStatus({
    lastDeliveryAt: new Date().toISOString(),
    lastDeliveryStatus: result.status,
    lastDeliveryMessageId: String(record.messageId ?? result.messageId),
    lastDeliveryMatchedRuleCount: result.matchedRuleCount,
    lastDeliverySentPacketCount: result.sentPacketCount,
    lastDeliveryError: result.adapterOutcomes.find((outcome) => outcome.status === "failed")?.error ?? ""
  });
}

function recordHeartbeatDeliveryError(record: HeartbeatEventRecord, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  appendAdapterLog("heartbeat", {
    event: "delivery_error",
    level: "error",
    message: `Heartbeat delivery failed messageId=${record.messageId}: ${message}`,
    data: {
      messageId: record.messageId,
      error: message
    }
  });
  patchHeartbeatStatus({
    lastDeliveryAt: new Date().toISOString(),
    lastDeliveryStatus: "failed",
    lastDeliveryMessageId: String(record.messageId ?? ""),
    lastDeliveryMatchedRuleCount: 0,
    lastDeliverySentPacketCount: 0,
    lastDeliveryError: message
  });
}

function tickHeartbeat(task: RunningHeartbeatTask, scheduledAt: Date, tasks: RunningHeartbeatTask[]): void {
  const now = Math.floor(Date.now() / 1000);
  const scheduleName = task.schedule.name?.trim() || task.schedule.id;
  const rawMessage = scheduleMessage(task);
  const status = readGatewayStatus().heartbeat;
  const record: HeartbeatEventRecord = {
    time: now,
    rawMessage,
    messageId: `heartbeat-${task.routeId}-${task.ruleId}-${task.schedule.id}-${scheduledAt.getTime()}`,
    senderName: "RabiRoute 定时触发",
    intervalSeconds: task.schedule.type === "interval" ? task.schedule.intervalSeconds : undefined
  };

  appendHeartbeatEvent(record);
  appendAdapterLog("heartbeat", {
    event: "tick",
    message: rawMessage.slice(0, 500),
    data: {
      messageId: record.messageId,
      routeId: task.routeId,
      routeName: task.routeName,
      ruleId: task.ruleId,
      ruleName: task.ruleName,
      scheduleId: task.schedule.id,
      scheduleName,
      scheduleType: task.schedule.type,
      intervalSeconds: task.schedule.intervalSeconds
    }
  });
  const tickCount = (status?.tickCount ?? 0) + 1;
  patchHeartbeatStatus({
    enabled: true,
    intervalSeconds: task.schedule.type === "interval" ? task.schedule.intervalSeconds : undefined,
    message: rawMessage,
    lastTickAt: new Date().toISOString(),
    lastScheduleId: task.schedule.id,
    lastScheduleName: scheduleName,
    tickCount,
    scheduleCount: tasks.length
  });
  void forwardMessageAndWait("heartbeat", record, {
    triggerRouteId: task.routeId,
    triggerRuleId: task.ruleId,
    scheduleId: task.schedule.id,
    scheduleName
  })
    .then((result) => recordHeartbeatDelivery(record, result))
    .catch((error) => recordHeartbeatDeliveryError(record, error));
}

function armTask(task: RunningHeartbeatTask, tasks: RunningHeartbeatTask[], lastScheduledAt?: Date): void {
  const nextAt = nextHeartbeatScheduleTime(task.schedule, new Date(), { lastScheduledAt });
  task.nextAt = nextAt ?? undefined;
  if (!nextAt) {
    patchScheduleSummary(tasks);
    return;
  }

  const delay = Math.max(0, Math.min(maxTimeoutMs, nextAt.getTime() - Date.now()));
  task.timer = setTimeout(() => {
    if (Date.now() + 1000 < nextAt.getTime()) {
      armTask(task, tasks, lastScheduledAt);
      return;
    }
    tickHeartbeat(task, nextAt, tasks);
    armTask(task, tasks, nextAt);
  }, delay);
  patchScheduleSummary(tasks);
}

export function createHeartbeatAdapter(): MessageAdapter {
  return {
    type: "heartbeat",
    start() {
      const tasks = collectHeartbeatScheduleTasks(activeRouteProfiles(), config.heartbeatIntervalSeconds);
      patchHeartbeatStatus({
        enabled: true,
        intervalSeconds: config.heartbeatIntervalSeconds,
        message: config.heartbeatMessage,
        scheduleCount: tasks.length
      });
      appendAdapterLog("heartbeat", {
        event: "enabled",
        message: `Heartbeat enabled, schedules=${tasks.length}`,
        data: {
          scheduleCount: tasks.length,
          schedules: tasks.map((task) => ({
            routeId: task.routeId,
            ruleId: task.ruleId,
            scheduleId: task.schedule.id,
            scheduleName: task.schedule.name,
            scheduleType: task.schedule.type,
            intervalSeconds: task.schedule.intervalSeconds,
            windowStartTime: task.schedule.windowStartTime,
            windowEndTime: task.schedule.windowEndTime,
            timeOfDay: task.schedule.timeOfDay,
            onceAt: task.schedule.onceAt
          }))
        }
      });
      console.log(`RabiRoute heartbeat adapter enabled, schedules=${tasks.length}`);
      tasks.forEach((task) => armTask(task, tasks));
      patchScheduleSummary(tasks);
    }
  };
}
