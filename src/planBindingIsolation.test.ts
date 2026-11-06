import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensurePersonaPlanWorkflow } from "./personaPlanWorkflow.js";
import { createPlan, clearPlanCatalogAfterStartupMigration, listPlansAsync, readPlansFromStorageInWorker } from "./roleKnowledge.js";
import { planJsonFile } from "./planStorageLayout.js";

for (const mode of ["worker", "async"] as const) {
  test(`a damaged stored instance binding leaves other plans usable in the ${mode} catalog`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-binding-isolation-"));
    t.after(() => { clearPlanCatalogAfterStartupMigration(root); fs.rmSync(root, { recursive: true, force: true }); });
    ensurePersonaPlanWorkflow(root);
    const input = (id: string, remote = false) => ({ id, title: id, keywords: ["fixture"], status: "分析中", currentStepId: "inspect",
      steps: [{ id: "inspect", title: "Inspect" }], taskBinding: { agentType: "codex", sessionId: "same-original-session",
        ...(remote ? { instanceBinding: { instanceId: "original-computer", agentId: "original-agent" } } : {}) } });
    createPlan(root, input("healthy-local"));
    createPlan(root, input("healthy-remote", true));
    createPlan(root, input("damaged", true));
    const file = planJsonFile(root, "damaged", "active");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.taskBinding.instanceBinding = { instanceId: "missing-agent" };
    fs.writeFileSync(file, JSON.stringify(raw));
    const before = fs.readFileSync(file);
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    clearPlanCatalogAfterStartupMigration(root);
    const plans = mode === "worker" ? readPlansFromStorageInWorker(root) : await listPlansAsync(root, { watch: false });
    assert.deepEqual(plans.map(plan => plan.id).sort(), ["healthy-local", "healthy-remote"]);
    assert.ok(warnings.some(args => args[1] && typeof args[1] === "object"
      && (args[1] as { planId?: unknown }).planId === "damaged"), "the owner diagnoses the isolated plan by its real ID");
    assert.equal(plans.find(plan => plan.id === "healthy-local")?.taskBinding?.instanceBinding, undefined);
    assert.deepEqual(plans.find(plan => plan.id === "healthy-remote")?.taskBinding?.instanceBinding,
      { instanceId: "original-computer", agentId: "original-agent" });
    assert.deepEqual(fs.readFileSync(file), before, "a read never rewrites or retargets the damaged record");
    assert.throws(() => createPlan(root, { ...input("invalid-write"), taskBinding: raw.taskBinding }), /instanceBinding/);
    assert.equal(fs.existsSync(planJsonFile(root, "invalid-write", "active")), false);
    createPlan(root, input("new-healthy"));
    assert.deepEqual(fs.readFileSync(file), before, "an unrelated successful write preserves the damaged bytes");
  });
}
