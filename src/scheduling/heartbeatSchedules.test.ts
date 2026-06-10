import assert from "node:assert/strict";
import test from "node:test";
import { nextHeartbeatScheduleTime } from "./heartbeatSchedules.js";
import type { NotificationScheduleDefinition } from "../shared/gatewayConfigModel.js";

function localDate(value: string): Date {
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

function isoLocal(value: Date | null): string | null {
  if (!value) return null;
  const pad = (item: number) => String(item).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

test("interval schedule without window waits for the next interval", () => {
  const schedule: NotificationScheduleDefinition = {
    id: "interval",
    type: "interval",
    intervalSeconds: 900
  };
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T10:00:00"))), "2026-06-10T10:15:00");
});

test("windowed interval anchors to the window start and skips missed slots", () => {
  const schedule: NotificationScheduleDefinition = {
    id: "daytime",
    type: "interval",
    intervalSeconds: 900,
    windowStartTime: "09:30",
    windowEndTime: "19:00"
  };
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T09:00:00"))), "2026-06-10T09:30:00");
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T10:07:00"))), "2026-06-10T10:15:00");
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T19:01:00"))), "2026-06-11T09:30:00");
});

test("daily schedule uses today when pending and tomorrow after the time passes", () => {
  const schedule: NotificationScheduleDefinition = {
    id: "daily",
    type: "daily_time",
    timeOfDay: "09:30"
  };
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T09:00:00"))), "2026-06-10T09:30:00");
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T09:31:00"))), "2026-06-11T09:30:00");
});

test("once schedule only returns a future time and never backfills", () => {
  const schedule: NotificationScheduleDefinition = {
    id: "once",
    type: "once_at",
    onceAt: "2026-06-15T09:30"
  };
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T09:00:00"))), "2026-06-15T09:30:00");
  assert.equal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-16T09:00:00")), null);
  assert.equal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T09:00:00"), { lastScheduledAt: localDate("2026-06-15T09:30:00") }), null);
});
