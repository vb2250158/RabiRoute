import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDsBotAutomationRuleOwner } from "../../../io.rabiroute.manager.persona/src/manager/dsBotAutomationRuleOperations.js";
import { createRoleAutomationScheduler } from "./roleAutomationScheduler.js";

test("old-root schedule cannot acquire a new-root work lease or claim its delivery", { timeout: 10_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-role-root-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ["A", "B"]) {
    const directory = path.join(root, name, "SameRole");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "personaConfig.json"), JSON.stringify({ automationRules: [{
      id: "same-rule", enabled: true, trigger: { type: "schedule", schedule: { id: "same", type: "interval", intervalSeconds: 1 } },
      action: { type: "deliver_agent", message: `Body ${name}`, target: { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", dshBaseUrl: "http://localhost:3000", botScopeId: "scope", botId: "bot", botName: "Bot" } }
    }] }));
  }
  let currentRoot = path.join(root, "A");
  const source = createDsBotAutomationRuleOwner({ rolesRoot: () => currentRoot, identity: () => ({ applicationGenerationId: "generation", managerInstanceId: "instance" }) });
  let now = new Date("2026-11-11T10:00:00Z");
  const timers: Array<() => void> = [];
  let claims = 0;
  const bodies: string[] = [];
  let rejectOldTask!: () => void;
  const oldTaskRejected = new Promise<void>(resolve => { rejectOldTask = resolve; });
  let observeRefreshedTimer: ((callback: () => void) => void) | undefined;
  let observeDelivery!: () => void;
  const deliveryObserved = new Promise<void>(resolve => { observeDelivery = resolve; });
  const scheduler = createRoleAutomationScheduler({ source, now: () => now,
    setTimer(callback) { timers.push(callback); observeRefreshedTimer?.(callback); return {} as NodeJS.Timeout; }, clearTimer() {},
    diagnostic(event) { if (event === "role_automation_delivery_failed") rejectOldTask(); },
    claim() { claims++; return true; }, finish() {},
    async deliver(task) { if (task.rule.action.type === "deliver_agent") bodies.push(task.rule.action.message || ""); observeDelivery(); return { statusCode: 200, data: { dsBot: { state: "accepted" } } }; }
  });
  try {
    await scheduler.start(); assert.equal(timers.length, 1);
    const originalSnapshot = await source.readScheduleSnapshot();
    currentRoot = path.join(root, "B");
    now = new Date("2026-11-11T10:00:01Z"); timers[0]!();
    await oldTaskRejected;
    assert.equal(claims, 0, "A's old task must not claim work using B's role lease");
    assert.deepEqual(bodies, []);
    await fs.copyFile(path.join(root, "A", "SameRole", "personaConfig.json"), path.join(root, "B", "SameRole", "personaConfig.json"));
    const previousTimers = timers.length;
    const refreshedTimer = new Promise<() => void>(resolve => { observeRefreshedTimer = resolve; });
    source.invalidate();
    const runRefreshedTimer = await refreshedTimer;
    observeRefreshedTimer = undefined;
    const currentSnapshot = await source.readScheduleSnapshot();
    assert.notEqual(currentSnapshot.revision, originalSnapshot.revision, "identical rule content under a new root must refresh timers");
    assert.notEqual(currentSnapshot.tasks[0]!.storageOwner, originalSnapshot.tasks[0]!.storageOwner);
    assert.ok(timers.length > previousTimers);
    now = new Date("2026-11-11T10:00:02Z"); runRefreshedTimer();
    await deliveryObserved;
    await scheduler.stop();
    assert.equal(claims, 1, "B's current task may acquire B's work lease after refresh");
    assert.deepEqual(bodies, ["Body A"]);
  } finally { await scheduler.stop(); await source.dispose(); }
});
