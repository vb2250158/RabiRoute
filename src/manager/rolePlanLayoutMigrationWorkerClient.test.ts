import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateRolePlanLayoutInWorker } from "./rolePlanLayoutMigrationWorkerClient.js";

test("startup plan layout migration yields the Manager event loop", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-migration-worker-"));
  const legacyFile = path.join(roleDir, "plans", "items", "active", "legacy-worker-plan.json");
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, JSON.stringify({
    schemaVersion: 2,
    id: "legacy-worker-plan",
    title: "旧计划迁移 worker",
    focus: "验证启动迁移不阻塞 Manager",
    status: "进行中",
    currentStepId: "migrate",
    steps: [{ id: "migrate", title: "迁移", status: "进行中" }],
    keywords: ["启动迁移"]
  }), "utf8");

  try {
    let eventLoopYielded = false;
    setImmediate(() => { eventLoopYielded = true; });
    const outcome = await migrateRolePlanLayoutInWorker(roleDir);
    assert.equal(eventLoopYielded, true);
    assert.equal(outcome.migrated, 1);
    assert.equal(outcome.failures.length, 0);
    assert.equal(fs.existsSync(legacyFile), false);
    assert.equal(
      fs.existsSync(path.join(roleDir, "plans", "active", "legacy-worker-plan", "plan.json")),
      true
    );
  } finally {
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});
