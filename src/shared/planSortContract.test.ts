import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_IMPORTANCE_PRESENTATION,
  PLAN_URGENCY_PRESENTATION,
  PlanImportanceLevel,
  PlanStatusSortLevel,
  PlanUrgencyLevel,
  resolvePlanImportanceLevel,
  resolvePlanUrgencyLevel
} from "./planSortContract.js";

test("plan sort levels use integers while labels and colors stay presentation-only", () => {
  assert.equal(PlanStatusSortLevel.Approval, 0);
  assert.equal(PlanStatusSortLevel.Discussion, 1);
  assert.equal(PlanStatusSortLevel.Qa, 2);
  assert.equal(PlanStatusSortLevel.Running, 3);
  assert.equal(PlanImportanceLevel.Highest, 0);
  assert.equal(PlanUrgencyLevel.Critical, 0);

  assert.equal(PLAN_IMPORTANCE_PRESENTATION[PlanImportanceLevel.Highest].labelZh, "最高");
  assert.equal(PLAN_IMPORTANCE_PRESENTATION[PlanImportanceLevel.High].labelZh, "高");
  assert.notEqual(
    PLAN_IMPORTANCE_PRESENTATION[PlanImportanceLevel.Highest].palette.background,
    PLAN_IMPORTANCE_PRESENTATION[PlanImportanceLevel.High].palette.background
  );
  assert.equal(PLAN_URGENCY_PRESENTATION[PlanUrgencyLevel.Critical].labelZh, "紧急");
  assert.notEqual(
    PLAN_URGENCY_PRESENTATION[PlanUrgencyLevel.Critical].palette.background,
    PLAN_URGENCY_PRESENTATION[PlanUrgencyLevel.Medium].palette.background
  );
});

test("legacy importance values map once to integer levels without fuzzy string sorting", () => {
  assert.equal(resolvePlanImportanceLevel(PlanImportanceLevel.Highest), PlanImportanceLevel.Highest);
  assert.equal(resolvePlanImportanceLevel("P0"), PlanImportanceLevel.Highest);
  assert.equal(resolvePlanImportanceLevel("critical"), PlanImportanceLevel.Highest);
  assert.equal(resolvePlanImportanceLevel("1:非常重要"), PlanImportanceLevel.Highest);
  assert.equal(resolvePlanImportanceLevel("high"), PlanImportanceLevel.High);
  assert.equal(resolvePlanImportanceLevel("2:重要"), PlanImportanceLevel.High);
  assert.equal(resolvePlanImportanceLevel("medium"), PlanImportanceLevel.Medium);
  assert.equal(resolvePlanImportanceLevel("low"), PlanImportanceLevel.Low);
  assert.equal(resolvePlanImportanceLevel("high-ish"), PlanImportanceLevel.Unset);
  assert.equal(resolvePlanImportanceLevel(undefined), PlanImportanceLevel.Unset);
});

test("urgency sorting uses an integer level and only derives a level for legacy deadlines", () => {
  const now = Date.UTC(2026, 7, 14, 12, 0, 0);
  assert.equal(resolvePlanUrgencyLevel(PlanUrgencyLevel.Low, new Date(now - 60_000).toISOString(), now), PlanUrgencyLevel.Low);
  assert.equal(resolvePlanUrgencyLevel(undefined, new Date(now - 60_000).toISOString(), now), PlanUrgencyLevel.Critical);
  assert.equal(resolvePlanUrgencyLevel(undefined, new Date(now + 2 * 24 * 60 * 60_000).toISOString(), now), PlanUrgencyLevel.High);
  assert.equal(resolvePlanUrgencyLevel(undefined, new Date(now + 6 * 24 * 60 * 60_000).toISOString(), now), PlanUrgencyLevel.Medium);
  assert.equal(resolvePlanUrgencyLevel(undefined, new Date(now + 10 * 24 * 60 * 60_000).toISOString(), now), PlanUrgencyLevel.Low);
  assert.equal(resolvePlanUrgencyLevel(undefined, undefined, now), PlanUrgencyLevel.Unset);
});
