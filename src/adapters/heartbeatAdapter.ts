import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessageAndWait, type ForwardDeliveryResult } from "../forwarding.js";
import { appendAdapterLog, appendHeartbeatEvent, type HeartbeatEventRecord } from "../history.js";
import {
  nextHeartbeatScheduleTime,
} from "../scheduling/heartbeatSchedules.js";
import {
  automationRunId,
  claimAutomationRun,
  collectScheduledAutomationTasks,
  executeScriptAutomation,
  finishAutomationRun,
  type ScriptAutomationTask,
  type ScheduledAutomationTask
} from "../automation/personaAutomationRuntime.js";
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
    lastTaskId?: string;
    lastTaskName?: string;
    lastActionType?: string;
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
    lastTaskId?: string;
    lastTaskName?: string;
    lastActionType?: string;
  };
};

type RunningHeartbeatTask = ScheduledAutomationTask & {
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
  if (task.rule.action.type !== "deliver_agent") return "";
  return task.rule.action.message?.trim()
    || `定时任务触发：${task.rule.name?.trim() || task.rule.id}`;
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
  const schedule = task.rule.trigger.schedule;
  const routeId = task.route.id;
  const routeName = task.route.name;
  const taskName = task.rule.name?.trim() || task.rule.id;
  const runId = automationRunId(routeId, task.rule.id, { scheduledAt });
  if (!claimAutomationRun(runId, {
    routeId,
    automationRuleId: task.rule.id,
    triggerType: "schedule",
    scheduledAt: scheduledAt.toISOString(),
    actionType: task.rule.action.type
  })) {
    appendAdapterLog("heartbeat", {
      event: "automation_duplicate_skipped",
      level: "warning",
      message: `Scheduled automation already claimed route=${routeId} rule=${task.rule.id}`,
      data: { runId, routeId, automationRuleId: task.rule.id, scheduledAt: scheduledAt.toISOString() }
    });
    return;
  }

  if (task.rule.action.type === "run_script") {
    appendAdapterLog("heartbeat", {
      event: "script_started",
      message: `Scheduled persona script started route=${routeId} rule=${task.rule.id}`,
      data: { runId, routeId, routeName, automationRuleId: task.rule.id, taskName, scheduledAt: scheduledAt.toISOString() }
    });
    patchHeartbeatStatus({
      enabled: true,
      lastTickAt: new Date().toISOString(),
      lastScheduleId: schedule.id,
      lastScheduleName: schedule.name?.trim() || schedule.id,
      lastTaskId: task.rule.id,
      lastTaskName: taskName,
      lastActionType: task.rule.action.type,
      scheduleCount: tasks.length
    });
    void executeScriptAutomation({ route: task.route, rule: task.rule as ScriptAutomationTask["rule"] }).then((result) => {
      finishAutomationRun(runId, result.status, {
        routeId,
        automationRuleId: task.rule.id,
        reason: result.reason,
        exitCode: result.exitCode,
        durationMs: result.durationMs
      });
      appendAdapterLog("heartbeat", {
        event: "script_result",
        level: result.status === "completed" ? "info" : result.status === "skipped" ? "warning" : "error",
        message: `Scheduled persona script ${result.status} route=${routeId} rule=${task.rule.id}`,
        data: { runId, routeId, routeName, automationRuleId: task.rule.id, taskName, ...result }
      });
      patchHeartbeatStatus({
        lastDeliveryAt: new Date().toISOString(),
        lastDeliveryStatus: result.status,
        lastDeliveryMessageId: runId,
        lastDeliveryMatchedRuleCount: 1,
        lastDeliverySentPacketCount: 0,
        lastDeliveryError: result.status === "completed" ? "" : result.reason || "script_failed",
        lastTaskId: task.rule.id,
        lastTaskName: taskName,
        lastActionType: task.rule.action.type
      });
    });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const scheduleName = schedule.name?.trim() || schedule.id;
  const rawMessage = scheduleMessage(task);
  const status = readGatewayStatus().heartbeat;
  const record: HeartbeatEventRecord = {
    time: now,
    rawMessage,
    messageId: `heartbeat-${routeId}-${task.rule.id}-${schedule.id}-${scheduledAt.getTime()}`,
    senderName: "RabiRoute 定时触发",
    intervalSeconds: schedule.type === "interval" ? schedule.intervalSeconds : undefined
  };

  appendHeartbeatEvent(record);
  appendAdapterLog("heartbeat", {
    event: "tick",
    message: rawMessage.slice(0, 500),
    data: {
      messageId: record.messageId,
      routeId,
      routeName,
      automationRuleId: task.rule.id,
      taskName,
      scheduleId: schedule.id,
      scheduleName,
      scheduleType: schedule.type,
      intervalSeconds: schedule.intervalSeconds,
      actionType: task.rule.action.type
    }
  });
  const tickCount = (status?.tickCount ?? 0) + 1;
  patchHeartbeatStatus({
    enabled: true,
    intervalSeconds: schedule.type === "interval" ? schedule.intervalSeconds : undefined,
    message: rawMessage,
    lastTickAt: new Date().toISOString(),
    lastScheduleId: schedule.id,
    lastScheduleName: scheduleName,
    lastTaskId: task.rule.id,
    lastTaskName: taskName,
    lastActionType: task.rule.action.type,
    tickCount,
    scheduleCount: tasks.length
  });
  void forwardMessageAndWait("heartbeat", record, {
    triggerRouteId: routeId,
    automationRuleId: task.rule.id,
    automationRuleName: taskName,
    automationTemplate: task.rule.action.template || "",
    scheduleId: schedule.id,
    scheduleName
  })
    .then((result) => {
      finishAutomationRun(runId, result.status, {
        routeId,
        automationRuleId: task.rule.id,
        matchedRuleCount: result.matchedRuleCount,
        sentPacketCount: result.sentPacketCount
      });
      recordHeartbeatDelivery(record, result);
    })
    .catch((error) => {
      finishAutomationRun(runId, "failed", {
        routeId,
        automationRuleId: task.rule.id,
        error: error instanceof Error ? error.message : String(error)
      });
      recordHeartbeatDeliveryError(record, error);
    });
}

function armTask(task: RunningHeartbeatTask, tasks: RunningHeartbeatTask[], lastScheduledAt?: Date): void {
  const nextAt = nextHeartbeatScheduleTime(task.rule.trigger.schedule, new Date(), { lastScheduledAt });
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
      const tasks = collectScheduledAutomationTasks(activeRouteProfiles());
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
            routeId: task.route.id,
            automationRuleId: task.rule.id,
            automationRuleName: task.rule.name,
            actionType: task.rule.action.type,
            scheduleId: task.rule.trigger.schedule.id,
            scheduleName: task.rule.trigger.schedule.name,
            scheduleType: task.rule.trigger.schedule.type,
            intervalSeconds: task.rule.trigger.schedule.intervalSeconds,
            windowStartTime: task.rule.trigger.schedule.windowStartTime,
            windowEndTime: task.rule.trigger.schedule.windowEndTime,
            timeOfDay: task.rule.trigger.schedule.timeOfDay,
            onceAt: task.rule.trigger.schedule.onceAt
          }))
        }
      });
      console.log(`RabiRoute heartbeat adapter enabled, schedules=${tasks.length}`);
      tasks.forEach((task) => armTask(task, tasks));
      patchScheduleSummary(tasks);
    }
  };
}
