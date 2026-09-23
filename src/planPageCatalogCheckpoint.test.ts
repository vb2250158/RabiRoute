import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadPlanPageCheckpoint, savePlanPageCheckpoint, planPageCheckpointPath } from "./planPageCatalogCheckpoint.js";

const isString = (value: unknown): value is string => typeof value === "string";

test("checkpoint round trip is role scoped, disposable, and outside watched plans", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-checkpoint-"));
  try {
    assert.equal(await loadPlanPageCheckpoint(root, isString), undefined);
    const source = path.join(root, "plans", "active", "sample", "plan.json");
    await savePlanPageCheckpoint(root, new Map([[source, "projection"]]));
    assert.deepEqual(await loadPlanPageCheckpoint(root, isString), new Map([[source, "projection"]]));
    assert.equal(path.relative(root, planPageCheckpointPath(root)).startsWith("plans"), false);
    await fs.writeFile(planPageCheckpointPath(root), "{broken");
    assert.equal(await loadPlanPageCheckpoint(root, isString), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("checkpoint rejects checksum mismatch, root mismatch and source path escape", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "plan-checkpoint-"));
  try {
    const source = path.join(root, "plans", "archive", "sample", "plan.json");
    await savePlanPageCheckpoint(root, new Map([[source, "projection"]]));
    const original = JSON.parse(await fs.readFile(planPageCheckpointPath(root), "utf8"));
    for (const change of [
      { sha256: "invalid" }, { root: `${root}-other` },
      ...["active/../plan.json", "active/../../escape", "active\\sample\\plan.json"].map(relative => {
        const payload = JSON.stringify([[relative, "projection"]]);
        return { payload, sha256: createHash("sha256").update(payload).digest("hex") };
      })
    ]) {
      await fs.writeFile(planPageCheckpointPath(root), JSON.stringify({ ...original, ...change }));
      assert.equal(await loadPlanPageCheckpoint(root, isString), undefined);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
