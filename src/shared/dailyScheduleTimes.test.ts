import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDailyScheduleTimes, parseTimeOfDay } from "./dailyScheduleTimes.js";

test("daily times normalize all entries, sort and deduplicate equivalent seconds", () => {
  assert.deepEqual(normalizeDailyScheduleTimes({ timeOfDays: ["18:00", "9:00:00", "09:00", "10:00:05", "10:00"] }), ["09:00", "10:00", "10:00:05", "18:00"]);
  assert.deepEqual(normalizeDailyScheduleTimes({ timeOfDay: "9:30:05" }), ["09:30:05"]);
  assert.deepEqual(parseTimeOfDay("9:30:05"), { hours: 9, minutes: 30, seconds: 5 });
});

test("explicit invalid daily lists reject every entry together without legacy fallback", () => {
  for (const timeOfDays of [[], undefined, null, "10:00", ["10:00", "bad"], ["10:00", 14], ["24:00"], ["10:60"]]) assert.equal(normalizeDailyScheduleTimes({ timeOfDay: "09:00", timeOfDays }), null);
});
