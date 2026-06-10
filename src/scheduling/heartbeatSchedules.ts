import type { NotificationRule, RouteProfile } from "../config.js";
import type { NotificationScheduleDefinition } from "../shared/gatewayConfigModel.js";

export type HeartbeatScheduleTask = {
  routeId: string;
  routeName: string;
  ruleId: string;
  ruleName: string;
  schedule: NotificationScheduleDefinition;
};

type TimeOfDay = {
  hours: number;
  minutes: number;
  seconds: number;
};

const secondMs = 1000;
const minuteMs = 60 * secondMs;
const dayMs = 24 * 60 * minuteMs;

export function parseTimeOfDay(value: string | undefined): TimeOfDay | null {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }
  return { hours, minutes, seconds };
}

function atLocalTime(day: Date, time: TimeOfDay): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    time.hours,
    time.minutes,
    time.seconds,
    0
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + days,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds()
  );
}

function nextDailyAt(time: TimeOfDay, now: Date, lastScheduledAt?: Date): Date {
  let candidate = atLocalTime(lastScheduledAt ? addDays(lastScheduledAt, 1) : now, time);
  while (candidate.getTime() <= now.getTime()) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

function parseLocalDateTime(value: string | undefined): Date | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? "0"),
    0
  );
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function windowBoundsFor(day: Date, startTime: TimeOfDay, endTime: TimeOfDay): { start: Date; end: Date } {
  const start = atLocalTime(day, startTime);
  let end = atLocalTime(day, endTime);
  if (end.getTime() <= start.getTime()) {
    end = addDays(end, 1);
  }
  return { start, end };
}

function activeOrNextWindow(now: Date, startTime: TimeOfDay, endTime: TimeOfDay): { start: Date; end: Date } {
  const today = windowBoundsFor(now, startTime, endTime);
  if (now.getTime() < today.end.getTime()) {
    return today;
  }
  return windowBoundsFor(addDays(now, 1), startTime, endTime);
}

function nextIntervalWithoutWindow(intervalMs: number, now: Date, lastScheduledAt?: Date): Date {
  if (!lastScheduledAt) {
    return new Date(now.getTime() + intervalMs);
  }
  let candidateMs = lastScheduledAt.getTime() + intervalMs;
  while (candidateMs <= now.getTime()) {
    candidateMs += intervalMs;
  }
  return new Date(candidateMs);
}

function nextWindowedInterval(
  intervalMs: number,
  now: Date,
  startTime: TimeOfDay,
  endTime: TimeOfDay,
  lastScheduledAt?: Date
): Date {
  const currentWindow = activeOrNextWindow(now, startTime, endTime);

  if (lastScheduledAt) {
    let candidateMs = lastScheduledAt.getTime() + intervalMs;
    while (candidateMs <= now.getTime()) {
      candidateMs += intervalMs;
    }
    if (candidateMs < currentWindow.end.getTime()) {
      return new Date(Math.max(candidateMs, currentWindow.start.getTime()));
    }
  }

  if (now.getTime() < currentWindow.start.getTime()) {
    return currentWindow.start;
  }

  const elapsed = now.getTime() - currentWindow.start.getTime();
  const steps = Math.floor(elapsed / intervalMs) + 1;
  const candidate = new Date(currentWindow.start.getTime() + steps * intervalMs);
  if (candidate.getTime() < currentWindow.end.getTime()) {
    return candidate;
  }
  return windowBoundsFor(addDays(currentWindow.start, 1), startTime, endTime).start;
}

export function nextHeartbeatScheduleTime(
  schedule: NotificationScheduleDefinition,
  now = new Date(),
  options: { lastScheduledAt?: Date } = {}
): Date | null {
  if (schedule.enabled === false) return null;

  if (schedule.type === "daily_time") {
    const time = parseTimeOfDay(schedule.timeOfDay);
    return time ? nextDailyAt(time, now, options.lastScheduledAt) : null;
  }

  if (schedule.type === "once_at") {
    if (options.lastScheduledAt) return null;
    const onceAt = parseLocalDateTime(schedule.onceAt);
    return onceAt && onceAt.getTime() > now.getTime() ? onceAt : null;
  }

  const intervalSeconds = Number(schedule.intervalSeconds || 0);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  const intervalMs = Math.max(1, intervalSeconds) * secondMs;
  const startTime = parseTimeOfDay(schedule.windowStartTime);
  const endTime = parseTimeOfDay(schedule.windowEndTime);
  if (startTime && endTime) {
    return nextWindowedInterval(intervalMs, now, startTime, endTime, options.lastScheduledAt);
  }
  return nextIntervalWithoutWindow(intervalMs, now, options.lastScheduledAt);
}

export function legacyHeartbeatSchedule(intervalSeconds: number, name = "兼容旧定时触发"): NotificationScheduleDefinition {
  return {
    id: "legacy-interval",
    name,
    enabled: true,
    type: "interval",
    intervalSeconds
  };
}

export function collectHeartbeatScheduleTasks(
  routes: RouteProfile[],
  legacyIntervalSeconds: number
): HeartbeatScheduleTask[] {
  const tasks: HeartbeatScheduleTask[] = [];
  for (const route of routes) {
    if (route.enabled === false) continue;
    for (const rule of route.notificationRules) {
      if (!rule.enabled || !rule.routeKinds.includes("heartbeat")) continue;
      const schedules = Array.isArray(rule.schedules) && rule.schedules.length > 0
        ? rule.schedules
        : [legacyHeartbeatSchedule(legacyIntervalSeconds, rule.name || rule.id)];
      for (const schedule of schedules) {
        if (schedule.enabled === false) continue;
        tasks.push({
          routeId: route.id,
          routeName: route.name,
          ruleId: rule.id,
          ruleName: rule.name,
          schedule
        });
      }
    }
  }
  return tasks;
}

export function heartbeatScheduleLabel(task: HeartbeatScheduleTask): string {
  const scheduleName = task.schedule.name?.trim() || task.schedule.id;
  return `${task.ruleName || task.ruleId} / ${scheduleName}`;
}
