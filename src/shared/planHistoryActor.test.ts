import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePlanHistoryActor, resolvePlanHistoryActor } from "./planHistoryActor.js";
import { createPlan, listPlanHistory } from "../roleKnowledge.js";
import { readPlanStoragePackage } from "../planStorageRepository.js";
import { storageInventoryRevisionToken } from "./storageRevision.js";
import { ManagerStorageMutationPool } from "../manager/managerStorageMutationPool.js";

const source = { type: "agent", agentAdapter: "dsh", agentType: "业务Agent", sessionId: "session-full-identity-123456789", sessionName: "declared name" };
test("history source resolves host, full identity and owner name without trusting declarations", async () => {
  const actor = await resolvePlanHistoryActor(source, { readAgent: async identity => {
    assert.equal(identity.sessionId, source.sessionId);
    return { id: source.sessionId, title: "Owner name", cwd: "workspace" };
  } });
  assert.deepEqual(actor, { kind: "agent", agentType: "dsh", sessionId: source.sessionId, displayName: "Owner name", channel: "dsh", workspace: "workspace" });
  for (const owner of [{ id: "other", title: "Other" }, { id: source.sessionId, title: "Archived", archived: true }]) {
    await assert.rejects(resolvePlanHistoryActor(source, { readAgent: async () => owner }), /owner is invalid/);
  }
});

test("missing and unverified user or system sources remain unknown", async () => {
  const readAgent = async (): Promise<never> => { throw new Error("must not read a task binding"); };
  for (const value of [undefined, { type: "user" }, { type: "system", eventType: "test", eventName: "Test", eventId: "event" }]) {
    assert.deepEqual(await resolvePlanHistoryActor(value, { readAgent }), { kind: "unknown" });
  }
  assert.deepEqual(await resolvePlanHistoryActor({ type: "user" }, { readAgent, verifiedUserEntry: true }), { kind: "user", displayName: "用户", channel: "webgui" });
  assert.equal(normalizePlanHistoryActor(undefined), undefined);
  assert.equal(normalizePlanHistoryActor({ kind: "agent", agentType: "dsh" }), undefined);
  assert.deepEqual(normalizePlanHistoryActor({ kind: "user", injected: "discard" }), { kind: "user" });
});

test("real storage worker persists actors, preserves old history and fences idempotent attribution", async t => {
  const rolesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plan-history-actor-"));
  const roleDir = path.join(rolesRoot, "TestRole");
  fs.mkdirSync(roleDir);
  t.after(() => fs.rmSync(rolesRoot, { recursive: true, force: true }));
  const input = { id: "history-actor", title: "History actor", focus: "Persist attribution", status: "分析中", currentStepId: "check", steps: [{ id: "check", title: "Check" }], keywords: ["actor"] };
  const legacy = createPlan(roleDir, input);
  const historyPath = path.join(roleDir, "plans", "active", legacy.id, "history.jsonl");
  const history = JSON.parse(fs.readFileSync(historyPath, "utf8").trim());
  delete history.actor;
  fs.writeFileSync(historyPath, `${JSON.stringify(history)}\n`);
  assert.equal(listPlanHistory(roleDir, legacy.id)[0]?.actor, undefined);
  const pool = new ManagerStorageMutationPool({ rolesRoot, applicationGenerationId: "actor-generation", managerInstanceId: "actor-manager" });
  t.after(() => pool.stop());
  const actor = { kind: "agent" as const, agentType: "dsh", sessionId: source.sessionId, displayName: "Actual owner", channel: "dsh" };
  const options = { idempotencyKey: "actor-update", expectedRevision: storageInventoryRevisionToken(readPlanStoragePackage(roleDir, legacy.id, "active").inventoryHash), actor };
  const patch = { nextAction: "Review history", actor: { kind: "user" }, messageSource: source };
  const updated = await pool.updatePlan("TestRole", legacy.id, patch, options);
  assert.equal("actor" in updated, false);
  assert.equal("messageSource" in updated, false);
  assert.deepEqual(listPlanHistory(roleDir, legacy.id).at(-1)?.actor, actor);
  await pool.updatePlan("TestRole", legacy.id, patch, options);
  assert.equal(listPlanHistory(roleDir, legacy.id).length, 2);
  await assert.rejects(pool.updatePlan("TestRole", legacy.id, patch, { ...options, actor: { kind: "user" } }), /conflict/i);
  assert.deepEqual(listPlanHistory(roleDir, legacy.id).at(-1)?.actor, actor);
  const userOptions = { idempotencyKey: "user-update", expectedRevision: storageInventoryRevisionToken(readPlanStoragePackage(roleDir, legacy.id, "active").inventoryHash), actor: { kind: "user" as const, displayName: "用户", channel: "webgui" } };
  await pool.updatePlan("TestRole", legacy.id, { nextAction: "User review" }, userOptions);
  assert.deepEqual(listPlanHistory(roleDir, legacy.id).at(-1)?.actor, userOptions.actor);
  const created = await pool.createPlan("TestRole", "actor-created", { ...input, id: "actor-created" }, { idempotencyKey: "actor-create", expectedRevision: null, actor });
  assert.deepEqual(listPlanHistory(roleDir, created.id)[0]?.actor, actor);
  assert.equal("actor" in created, false);
});
