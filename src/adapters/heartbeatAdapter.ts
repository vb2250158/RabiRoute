import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { forwardMessageAndWait, type ForwardDeliveryResult } from "../forwarding.js";
import { appendAdapterLogToDir, appendHeartbeatEventToDir, type HeartbeatEventRecord } from "../history.js";
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
import type { MessageAdapter, MessageAdapterDispose } from "./messageAdapter.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

type GatewayStatus = {
  messageAdapters?: Record<string, {
    status?: "running" | "disabled" | "error";
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

export type HeartbeatAdapterDependencies = {
  collectTasks?: () => ScheduledAutomationTask[];
  dataDir?: () => string;
  now?: () => Date;
  nextScheduleTime?: typeof nextHeartbeatScheduleTime;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  runTask?: (task: ScheduledAutomationTask, scheduledAt: Date) => void;
};

type HeartbeatLifecycle = {
  active: boolean;
  tasks: RunningHeartbeatTask[];
  dataDir(): string;
  now(): Date;
  nextScheduleTime: typeof nextHeartbeatScheduleTime;
  setTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
  runTask(task: RunningHeartbeatTask, scheduledAt: Date): void;
};

const maxTimeoutMs = 2_147_483_647;

function gatewayStatusPath(dataDir: string): string {
  return path.join(dataDir, "gateway-status.json");
}

function readGatewayStatus(dataDir = config.dataDir): GatewayStatus {
  const statusPath = gatewayStatusPath(dataDir);
  if (!fs.existsSync(statusPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8")) as GatewayStatus;
  } catch {
    return {};
  }
}

function writeGatewayStatus(nextStatus: GatewayStatus, dataDir = config.dataDir): void {
  const statusPath = gatewayStatusPath(dataDir);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify(nextStatus, null, 2), "utf8");
    recordDataMutationAudit({ group: "gateway", event: "heartbeat_adapter_status_committed", owner: "heartbeat-adapter", action: "write-runtime-status", target: { type: "message-adapter", id: "heartbeat" }, dataSource: { kind: "runtime", id: "gateway-status" }, outcome: "committed" });
  } catch (error) {
    recordDataMutationAudit({ level: "error", group: "gateway", event: "heartbeat_adapter_status_write_failed", owner: "heartbeat-adapter", action: "write-runtime-status", target: { type: "message-adapter", id: "heartbeat" }, dataSource: { kind: "runtime", id: "gateway-status" }, outcome: "failed", error });
    throw error;
  }
}

function patchHeartbeatStatus(
  lifecycle: Pick<HeartbeatLifecycle, "dataDir" | "now">,
  patch: NonNullable<GatewayStatus["heartbeat"]>,
  lifecycleStatus?: "running" | "disabled" | "error"
): void {
  const dataDir = lifecycle.dataDir();
  const status = readGatewayStatus(dataDir);
  const current = status.messageAdapters?.heartbeat ?? {};
  const statusValue = lifecycleStatus
    ?? (current.status === "disabled" ? "disabled" : "running");
  writeGatewayStatus({
    ...status,
    messageAdapters: {
      ...status.messageAdapters,
      heartbeat: {
        ...current,
        status: statusValue,
        updatedAt: lifecycle.now().toISOString(),
        ...patch
      }
    },
    heartbeat: {
      ...status.heartbeat,
      ...patch
    }
  }, dataDir);
}

function appendHeartbeatLog(
  lifecycle: Pick<HeartbeatLifecycle, "dataDir">,
  record: Parameters<typeof appendAdapterLogToDir>[1]
): void {
  appendAdapterLogToDir("heartbeat", record, lifecycle.dataDir());
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

function patchScheduleSummary(lifecycle: HeartbeatLifecycle): void {
  patchHeartbeatStatus(lifecycle, {
    enabled: true,
    scheduleCount: lifecycle.tasks.length,
    nextTickAt: minNextTick(lifecycle.tasks)
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

function recordHeartbeatDelivery(lifecycle: HeartbeatLifecycle, record: HeartbeatEventRecord, result: ForwardDeliveryResult): void {
  appendHeartbeatLog(lifecycle, {
    event: "delivery_result",
    level: deliveryLogLevel(result),
    message: `Heartbeat delivery ${result.status} messageId=${record.messageId} matched=${result.matchedRuleCount} sent=${result.sentPacketCount}`,
    data: result
  });
  patchHeartbeatStatus(lifecycle, {
    lastDeliveryAt: lifecycle.now().toISOString(),
    lastDeliveryStatus: result.status,
    lastDeliveryMessageId: String(record.messageId ?? result.messageId),
    lastDeliveryMatchedRuleCount: result.matchedRuleCount,
    lastDeliverySentPacketCount: result.sentPacketCount,
    lastDeliveryError: result.adapterOutcomes.find((outcome) => outcome.status === "failed")?.error ?? ""
  });
}

function recordHeartbeatDeliveryError(lifecycle: HeartbeatLifecycle, record: HeartbeatEventRecord, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  appendHeartbeatLog(lifecycle, {
    event: "delivery_error",
    level: "error",
    message: `Heartbeat delivery failed messageId=${record.messageId}: ${message}`,
    data: {
      messageId: record.messageId,
      error: message
    }
  });
  patchHeartbeatStatus(lifecycle, {
    lastDeliveryAt: lifecycle.now().toISOString(),
    lastDeliveryStatus: "failed",
    lastDeliveryMessageId: String(record.messageId ?? ""),
    lastDeliveryMatchedRuleCount: 0,
    lastDeliverySentPacketCount: 0,
    lastDeliveryError: message
  });
}

function tickHeartbeat(task: RunningHeartbeatTask, scheduledAt: Date, lifecycle: HeartbeatLifecycle): void {
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
    appendHeartbeatLog(lifecycle, {
      event: "automation_duplicate_skipped",
      level: "warning",
      message: `Scheduled automation already claimed route=${routeId} rule=${task.rule.id}`,
      data: { runId, routeId, automationRuleId: task.rule.id, scheduledAt: scheduledAt.toISOString() }
    });
    return;
  }

  if (task.rule.action.type === "run_script") {
    appendHeartbeatLog(lifecycle, {
      event: "script_started",
      message: `Scheduled persona script started route=${routeId} rule=${task.rule.id}`,
      data: { runId, routeId, routeName, automationRuleId: task.rule.id, taskName, scheduledAt: scheduledAt.toISOString() }
    });
    patchHeartbeatStatus(lifecycle, {
      enabled: true,
      lastTickAt: lifecycle.now().toISOString(),
      lastScheduleId: schedule.id,
      lastScheduleName: schedule.name?.trim() || schedule.id,
      lastTaskId: task.rule.id,
      lastTaskName: taskName,
      lastActionType: task.rule.action.type,
      scheduleCount: lifecycle.tasks.length
    });
    void executeScriptAutomation({ route: task.route, rule: task.rule as ScriptAutomationTask["rule"] }).then((result) => {
      finishAutomationRun(runId, result.status, {
        routeId,
        automationRuleId: task.rule.id,
        reason: result.reason,
        exitCode: result.exitCode,
        durationMs: result.durationMs
      });
      appendHeartbeatLog(lifecycle, {
        event: "script_result",
        level: result.status === "completed" ? "info" : result.status === "skipped" ? "warning" : "error",
        message: `Scheduled persona script ${result.status} route=${routeId} rule=${task.rule.id}`,
        data: { runId, routeId, routeName, automationRuleId: task.rule.id, taskName, ...result }
      });
      patchHeartbeatStatus(lifecycle, {
        lastDeliveryAt: lifecycle.now().toISOString(),
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

  const now = Math.floor(lifecycle.now().getTime() / 1000);
  const scheduleName = schedule.name?.trim() || schedule.id;
  const rawMessage = scheduleMessage(task);
  const status = readGatewayStatus(lifecycle.dataDir()).heartbeat;
  const record: HeartbeatEventRecord = {
    time: now,
    rawMessage,
    messageId: `heartbeat-${routeId}-${task.rule.id}-${schedule.id}-${scheduledAt.getTime()}`,
    senderName: "RabiRoute 定时触发",
    intervalSeconds: schedule.type === "interval" ? schedule.intervalSeconds : undefined
  };

  appendHeartbeatEventToDir(record, lifecycle.dataDir());
  appendHeartbeatLog(lifecycle, {
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
  patchHeartbeatStatus(lifecycle, {
    enabled: true,
    intervalSeconds: schedule.type === "interval" ? schedule.intervalSeconds : undefined,
    message: rawMessage,
    lastTickAt: lifecycle.now().toISOString(),
    lastScheduleId: schedule.id,
    lastScheduleName: scheduleName,
    lastTaskId: task.rule.id,
    lastTaskName: taskName,
    lastActionType: task.rule.action.type,
    tickCount,
    scheduleCount: lifecycle.tasks.length
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
      recordHeartbeatDelivery(lifecycle, record, result);
    })
    .catch((error) => {
      finishAutomationRun(runId, "failed", {
        routeId,
        automationRuleId: task.rule.id,
        error: error instanceof Error ? error.message : String(error)
      });
      recordHeartbeatDeliveryError(lifecycle, record, error);
    });
}

function armTask(
  task: RunningHeartbeatTask,
  lifecycle: HeartbeatLifecycle,
  lastScheduledAt?: Date
): void {
  if (!lifecycle.active) return;
  const now = lifecycle.now();
  const nextAt = lifecycle.nextScheduleTime(task.rule.trigger.schedule, now, { lastScheduledAt });
  task.nextAt = nextAt ?? undefined;
  if (!nextAt) {
    patchScheduleSummary(lifecycle);
    return;
  }

  const delay = Math.max(0, Math.min(maxTimeoutMs, nextAt.getTime() - now.getTime()));
  task.timer = lifecycle.setTimer(() => {
    task.timer = undefined;
    if (!lifecycle.active) return;
    if (lifecycle.now().getTime() + 1000 < nextAt.getTime()) {
      armTask(task, lifecycle, lastScheduledAt);
      return;
    }
    lifecycle.runTask(task, nextAt);
    if (!lifecycle.active) return;
    armTask(task, lifecycle, nextAt);
  }, delay);
  patchScheduleSummary(lifecycle);
}

function clearHeartbeatTimers(lifecycle: HeartbeatLifecycle): void {
  for (const task of lifecycle.tasks) {
    if (task.timer) {
      lifecycle.clearTimer(task.timer);
      task.timer = undefined;
    }
    task.nextAt = undefined;
  }
}

export function createHeartbeatAdapter(
  dependencies: HeartbeatAdapterDependencies = {}
): MessageAdapter {
  return {
    type: "heartbeat",
    start() {
      const tasks = (dependencies.collectTasks?.()
        ?? collectScheduledAutomationTasks(activeRouteProfiles()))
        .map((task) => ({ ...task }));
      let lifecycle!: HeartbeatLifecycle;
      lifecycle = {
        active: true,
        tasks,
        dataDir: dependencies.dataDir ?? (() => config.dataDir),
        now: dependencies.now ?? (() => new Date()),
        nextScheduleTime: dependencies.nextScheduleTime ?? nextHeartbeatScheduleTime,
        setTimer: dependencies.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
        clearTimer: dependencies.clearTimer ?? ((timer) => clearTimeout(timer)),
        runTask(task, scheduledAt) {
          if (dependencies.runTask) {
            dependencies.runTask(task, scheduledAt);
            return;
          }
          tickHeartbeat(task, scheduledAt, lifecycle);
        }
      };

      const dispose: MessageAdapterDispose = () => {
        if (!lifecycle.active) return;
        lifecycle.active = false;
        clearHeartbeatTimers(lifecycle);
        patchHeartbeatStatus(lifecycle, {
          enabled: false,
          scheduleCount: lifecycle.tasks.length,
          nextTickAt: undefined
        }, "disabled");
        appendHeartbeatLog(lifecycle, {
          event: "disabled",
          message: `Heartbeat disabled, schedules=${lifecycle.tasks.length}`,
          data: { scheduleCount: lifecycle.tasks.length }
        });
      };

      patchHeartbeatStatus(lifecycle, {
        enabled: true,
        intervalSeconds: config.heartbeatIntervalSeconds,
        message: config.heartbeatMessage,
        scheduleCount: tasks.length
      }, "running");
      appendHeartbeatLog(lifecycle, {
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

      try {
        tasks.forEach((task) => armTask(task, lifecycle));
        patchScheduleSummary(lifecycle);
        return dispose;
      } catch (error) {
        lifecycle.active = false;
        clearHeartbeatTimers(lifecycle);
        const message = error instanceof Error ? error.message : String(error);
        patchHeartbeatStatus(lifecycle, {
          enabled: false,
          scheduleCount: tasks.length,
          nextTickAt: undefined,
          lastDeliveryError: message
        }, "error");
        appendHeartbeatLog(lifecycle, {
          event: "activation_failed",
          level: "error",
          message: `Heartbeat activation failed: ${message}`,
          data: { scheduleCount: tasks.length, error: message }
        });
        throw error;
      }
    }
  };
}
