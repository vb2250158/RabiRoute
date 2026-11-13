import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNotificationSchedule, notificationScheduleRowsFor, setNotificationSchedule } from "../utils/config-surface.js";

test("an unrelated legacy client edit retains all daily points on one schedule", () => {
  const schedule = { id: "clock", type: "daily_time", timeOfDays: ["10:00", "14:00", "18:00"] };
  const gateways = [{ id: "fixture", notificationRules: [{ id: "review", enabled: true, routeKinds: ["heartbeat"], schedules: [schedule] }] }];
  const edited = setNotificationSchedule(gateways, 0, 0, 0, { name: "Updated review" });
  const rows = notificationScheduleRowsFor(edited[0], 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "clock");
  assert.deepEqual(rows[0].timeOfDays, schedule.timeOfDays);
});

test("type changes discard a daily list while malformed lists remain visible for server validation", () => {
  assert.equal(normalizeNotificationSchedule({ id: "clock", type: "interval", intervalSeconds: 60, timeOfDays: ["10:00"] }).timeOfDays, undefined);
  assert.deepEqual(normalizeNotificationSchedule({ id: "clock", type: "daily_time", timeOfDays: ["10:00", "invalid"] }).timeOfDays, ["10:00", "invalid"]);
});
