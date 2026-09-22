import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { preparePlanAttachments } from "./planAttachments.js";
import { normalizePlanStepResources } from "./shared/planStepResources.js";
import { createPlan, updatePlan, getPlan } from "./roleKnowledge.js";

test("retained attachments do not consume a new upload batch", t => {
  const root = mkdtempSync(path.join(tmpdir(), "plan-resource-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = preparePlanAttachments(root, "p", Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: `${i}.txt`, contentBase64: "eA==" }))).map(item => item.metadata);
  const next = preparePlanAttachments(root, "p", [...previous.map(item => ({ id: item.id })), { id: "a8", name: "next.txt", contentBase64: "eQ==" }], previous);
  assert.equal(next.length, 9);
  assert.deepEqual(next.slice(0, 8).map(item => item.metadata), previous);
  assert.equal(next.filter(item => item.content).length, 1);
  assert.throws(() => preparePlanAttachments(root, "p", Array.from({ length: 9 }, (_, i) => ({ name: `${i}.txt`, contentBase64: "eA==" }))), /at most 8 attachments/);
});

test("step resources survive plan persistence without changing step text", t => {
  const root = mkdtempSync(path.join(tmpdir(), "step-resource-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = createPlan(root, { title: "Resource test", focus: "Record changes", status: "暂停", keywords: ["test"], steps: [{ id: "s", title: "Implement", detail: "Keep original" }] });
  const record = { id: "change-1", sessionId: "session-test", time: new Date().toISOString(), resources: [{ path: "src/demo.ts", change: "modified" as const, summary: "Update demo", attribution: "agent-reported" as const, sha256: "a".repeat(64) }] };
  updatePlan(root, plan.id, { steps: [{ ...plan.steps[0]!, resourceRecords: [record] }] });
  const saved = getPlan(root, plan.id)!;
  assert.equal(saved.steps[0]!.detail, "Keep original");
  assert.deepEqual(saved.steps[0]!.resourceRecords, [record]);
  updatePlan(root, plan.id, { steps: [{ id: "s", title: "Updated title", detail: "New text" }] });
  assert.deepEqual(getPlan(root, plan.id)!.steps[0]!.resourceRecords, [record]);
  assert.throws(() => normalizePlanStepResources([{ ...record, resources: [{ ...record.resources[0], sha256: "bad" }] }]), /digest/);
  assert.throws(() => normalizePlanStepResources([record, record]), /identity/);
});
