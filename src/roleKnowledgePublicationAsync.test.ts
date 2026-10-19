import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listPlans,
  publishRolePlanCatalog,
  publishRolePlanCatalogAsync,
  publishRoleKnowledgeCatalogSnapshot,
  publishRoleKnowledgeCatalogSnapshotAsync,
  readRoleKnowledgeCatalogSnapshot
} from "./roleKnowledge.js";

test("large catalog publication yields while preserving immutable, atomic visibility", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = publishRolePlanCatalog(root, [{ id: "original", title: "Original" }]);
  const plans = Array.from({ length: 300 }, (_, index) => ({
    id: `plan-${index}`, title: `Plan ${index}`, steps: [],
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
  }));
  let turns = 0;
  const timer = setInterval(() => {
    turns++;
    assert.equal(listPlans(root), original);
  }, 1);
  let published;
  try { published = await publishRolePlanCatalogAsync(root, plans, () => {}); }
  finally { clearInterval(timer); }
  assert.ok(turns > 0);
  assert.equal(published.length, plans.length);
  assert.ok(Object.isFrozen(published));
  assert.ok(Object.isFrozen(published[0].steps));
  plans[0].title = "Changed source";
  assert.equal(published[0].title, "Plan 0");
  let checks = 0;
  await assert.rejects(publishRolePlanCatalogAsync(root, plans, () => {
    if (++checks === 20) throw new Error("PLAN_CATALOG_DIRTY");
  }), /PLAN_CATALOG_DIRTY/);
  assert.equal(listPlans(root), published);
  await assert.rejects(publishRolePlanCatalogAsync(root, [plans[0], plans[0]], () => {}), /duplicate/);
  assert.equal(listPlans(root), published);
});

test("async knowledge publication matches synchronous normalization", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-publication-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = readRoleKnowledgeCatalogSnapshot(root);
  source.plans = [...publishRolePlanCatalog(root, [{ id: "plan", title: "Plan" }])];
  const expected = publishRoleKnowledgeCatalogSnapshot(root, source);
  const actual = await publishRoleKnowledgeCatalogSnapshotAsync(root, source, () => {});
  assert.deepEqual(actual, expected);
  assert.ok(Object.isFrozen(actual));
  assert.ok(Object.isFrozen(actual.plans));
  assert.ok(Object.isFrozen(actual.skills));
});
