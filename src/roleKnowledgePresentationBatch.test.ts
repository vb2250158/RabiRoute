import assert from "node:assert/strict";
import test from "node:test";
import type { PlanItem } from "./roleKnowledge.js";
import { loadDefaultPersonaPlanWorkflow } from "./personaPlanWorkflow.js";
import { presentPlan, presentPlans } from "./roleKnowledgePresentation.js";

test("batch status lookup preserves individual presentation and mutable workflow invalidation", () => {
  const workflow = loadDefaultPersonaPlanWorkflow();
  const rows: PlanItem[] = workflow.statuses.map((status, index) => ({
    id: `synthetic-${index}`, title: "Synthetic", focus: "Synthetic",
    status: status.key, activationStatus: "进行中", markerStatus: status.key,
    archiveStatus: "未归档", attachments: [], steps: [], keywords: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  }));
  const first = presentPlans(rows, workflow);
  for (const row of rows) assert.deepEqual(first.find(item => item.id === row.id), presentPlan(row, workflow));
  assert.equal(presentPlans(rows, workflow), first);
  workflow.statuses[0]!.label = "Changed synthetic label";
  const second = presentPlans(rows, workflow);
  assert.notEqual(second, first);
  assert.equal(second.find(item => item.id === rows[0]!.id)!.presentation.label, "Changed synthetic label");
  assert.throws(() => presentPlans([{ ...rows[0]!, status: "unknown-synthetic-status" }], workflow), /PLAN_STATUS_CONFIG_INVALID/);
});
