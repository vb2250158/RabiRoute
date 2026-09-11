import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPangHuIssueForPlan } from "./pangHuIssueLedger.js";

test("issue lookup uses the resolved external persona directory and exact plan identity", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-issue-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const roleDir = path.join(root, "external-personas", "XinghaiBuilder");
  fs.mkdirSync(path.join(roleDir, "state"), { recursive: true });
  const entry = { planId: "plan-1", signature: { groupId: "123", sourceMessageId: "456" } };
  const ledgerPath = path.join(roleDir, "state", "issue-threads.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ items: [null, { planId: "plan-10" }, entry] }));
  assert.deepEqual(readPangHuIssueForPlan(roleDir, "plan-1"), entry);
  assert.equal(readPangHuIssueForPlan(roleDir, "missing"), undefined);
  assert.throws(() => readPangHuIssueForPlan(path.join(root, "install", "data", "roles", "XinghaiBuilder"), "plan-1"), { code: "ENOENT" });
  fs.writeFileSync(ledgerPath, "invalid json");
  assert.throws(() => readPangHuIssueForPlan(roleDir, "plan-1"), SyntaxError);
});
