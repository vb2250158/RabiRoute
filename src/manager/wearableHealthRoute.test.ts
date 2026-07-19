import assert from "node:assert/strict";
import test from "node:test";
import { parseWearableHealthResourceRoute } from "./wearableHealthRoute.js";

test("parses wearable health role routes", () => {
  assert.deepEqual(parseWearableHealthResourceRoute("/api/roles/YeYu/health/state"), {
    roleId: "YeYu",
    resource: "state"
  });
  assert.deepEqual(parseWearableHealthResourceRoute("/roles/Rabi%20Active/health/history"), {
    roleId: "Rabi Active",
    resource: "history"
  });
  assert.deepEqual(parseWearableHealthResourceRoute("/api/roles/YeYu/health"), {
    roleId: "YeYu",
    resource: "summary"
  });
  assert.equal(parseWearableHealthResourceRoute("/api/roles/YeYu/plans"), null);
});
