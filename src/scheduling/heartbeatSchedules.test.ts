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

test("daily multi-time schedule advances within the same rule and across midnight", () => {
  const schedule = { id: "daily", type: "daily_time", timeOfDay: "08:00", timeOfDays: ["18:00", "10:00", "14:00", "10:00"] } as NotificationScheduleDefinition;
  for (const [now, last, expected] of [
    ["2026-06-10T09:00:00", undefined, "2026-06-10T10:00:00"],
    ["2026-06-10T10:00:00", "2026-06-10T10:00:00", "2026-06-10T14:00:00"],
    ["2026-06-10T14:00:00", "2026-06-10T14:00:00", "2026-06-10T18:00:00"],
    ["2026-12-31T18:00:00", "2026-12-31T18:00:00", "2027-01-01T10:00:00"],
    ["2026-06-10T11:00:00", "2026-06-11T10:00:00", "2026-06-11T14:00:00"],
  ]) assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate(now!), { lastScheduledAt: last ? localDate(last) : undefined })), expected);
});

test("invalid multi-time schedules never partially run or fall back to the legacy time", () => {
  for (const timeOfDays of [[], ["10:00", "bad"], ["25:00"], ["10:00", 14], null]) {
    const schedule = { id: "bad", type: "daily_time", timeOfDay: "09:00", timeOfDays } as unknown as NotificationScheduleDefinition;
    assert.equal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T08:00:00")), null);
  }
});

test("daily seconds remain precise and missed points are skipped without losing later points", () => {
  const schedule: NotificationScheduleDefinition = { id: "seconds", type: "daily_time", timeOfDays: ["10:00:05", "14:00:30"] };
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T10:00:04"))), "2026-06-10T10:00:05");
  assert.equal(isoLocal(nextHeartbeatScheduleTime(schedule, localDate("2026-06-10T13:00:00"), { lastScheduledAt: localDate("2026-06-09T10:00:05") })), "2026-06-10T14:00:30");
  assert.equal(isoLocal(nextHeartbeatScheduleTime({ id: "old", type: "daily_time", timeOfDay: "09:30:05" }, localDate("2026-06-10T09:30:00"))), "2026-06-10T09:30:05");
});
