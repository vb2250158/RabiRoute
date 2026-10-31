import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { publishStartupPlanConflicts } from "./planStorageStartupPublication.js";
import { publishedRolePlanPackageRecoverySnapshot } from "../roleKnowledge.js";
import { planReadFence } from "../planReadInvalidation.js";

test("startup conflicts invalidate cached reads once and survive incomplete progress", () => {
  const root = path.join(os.tmpdir(), randomUUID());
  const role = path.join(root, "Example");
  const summary = { roles: 1, migrated: 0, reconciled: 0, failures: [], skipped: false,
    packageConflicts: [{ roleId: "Example", planId: "bad", transactionPath: "receipt", message: "conflict" }] };
  const initial = planReadFence(role).revision;
  publishStartupPlanConflicts(root, summary);
  assert.equal(planReadFence(role).revision, initial + 1);
  publishStartupPlanConflicts(root, summary);
  publishStartupPlanConflicts(root, { ...summary, packageConflicts: [] });
  assert.equal(planReadFence(role).revision, initial + 1);
  assert.equal(publishedRolePlanPackageRecoverySnapshot(role)?.conflicts[0].planId, "bad");
});
