import test from "node:test";
import assert from "node:assert/strict";
import { createRoleAutomationScheduler, roleAutomationMessage, type RoleScheduledTask } from "./roleAutomationScheduler.js";

test("role scheduler uses native task identity, drains delivery and replaces source timers", async () => {
  let listener = () => {};
  const timers = new Map<NodeJS.Timeout, () => void>();
  const task = { sourceRoleId: "Independent", rawRuleId: "daily", rule: { id: "daily", enabled: true, trigger: { type: "schedule", schedule: { id: "daily", type: "interval", intervalSeconds: 1 } }, action: { type: "deliver_agent", message: "Native", target: { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", botScopeId: "scope", botId: "bot", botName: "Bot" } } } } as RoleScheduledTask;
  task.rule.trigger.schedule.enabled = true;
  if (task.rule.action.type === "deliver_agent") task.rule.action.template = "For {roleId}: {message}; {routeName}";
  assert.equal(roleAutomationMessage(task, new Date("2026-11-11T10:00:00Z")), "Native\n\n[用户模板补充]\nFor Independent: Native; {routeName}");
  let revision = "one", scheduledTasks = [task];
  let now = new Date("2026-11-11T09:59:59Z");
  const claims: string[] = [], finishes: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let called = false;
  const scheduler = createRoleAutomationScheduler({
    source: { async acquireTaskLease() { return { assertCurrent() {}, async release() {} }; }, async readScheduleSnapshot() { return { revision, tasks: scheduledTasks, warnings: [] }; }, subscribeChanged(callback) { listener = callback; return () => { listener = () => {}; }; } },
    now: () => now,
    setTimer(callback) { const handle = {} as NodeJS.Timeout; timers.set(handle, callback); return handle; }, clearTimer(handle) { timers.delete(handle); },
    claim(runId) { claims.push(runId); return true; }, finish(runId) { finishes.push(runId); }, diagnostic() {},
    async deliver(actual, runId) { called = true; assert.equal(actual.sourceRoleId, "Independent"); assert.ok(runId.startsWith("role-automation:")); assert.equal("route" in actual, false); await gate; return { statusCode: 200, data: {} }; }
  });
  await scheduler.start(); assert.equal(timers.size, 1);
  now = new Date("2026-11-11T10:00:00Z");
  const callback = [...timers.values()][0]!; timers.clear(); callback();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(called, true); assert.equal(claims.length, 1);
  revision = "two"; scheduledTasks = []; listener();
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(timers.size, 0);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release(); await stopping; assert.equal(finishes.length, 1);
});

test("native uncertain, conflict and missing receipts retain the original claim without false completion", async () => {
  const tasks = ["accepted", "uncertain", "conflict", "not_found", "missing", "throw"].map(state => ({
    sourceRoleId: "Role", rawRuleId: state, rule: { id: state, trigger: { type: "schedule", schedule: { id: state, type: "interval", intervalSeconds: 1 } }, action: { type: "deliver_agent", message: state } }
  } as RoleScheduledTask));
  const callbacks: Array<() => void> = [], claimed = new Set<string>();
  const statuses: Array<{ rule: unknown; status: string }> = [];
  let deliveries = 0;
  let now = new Date("2026-11-11T10:00:00Z");
  const scheduler = createRoleAutomationScheduler({
    source: { async readScheduleSnapshot() { return { revision: "one", tasks, warnings: [] }; }, subscribeChanged() { return () => {}; }, async acquireTaskLease() { return { assertCurrent() {}, async release() {} }; } },
    now: () => now, setTimer(callback) { callbacks.push(callback); return {} as NodeJS.Timeout; }, clearTimer() {}, diagnostic() {},
    claim(id) { if (claimed.has(id)) return false; claimed.add(id); return true; }, finish(_id, status, metadata) { statuses.push({ rule: metadata?.automationRuleId, status }); },
    async deliver(task) { deliveries++; if (task.rawRuleId === "throw") throw Object.assign(new Error("private payload token"), { uncertain: true, code: "DS_BOT_UNCONFIRMED" }); return { statusCode: 200, data: task.rawRuleId === "missing" ? {} : { dsBot: { state: task.rawRuleId } } }; }
  });
  await scheduler.start(); now = new Date("2026-11-11T10:00:01Z");
  const first = callbacks.slice(); first.forEach(callback => callback());
  await new Promise<void>(resolve => setImmediate(resolve));
  first.forEach(callback => callback());
  await new Promise<void>(resolve => setImmediate(resolve));
  await scheduler.stop();
  assert.equal(deliveries, 6);
  assert.deepEqual(statuses.map(item => item.status).sort(), ["accepted", "conflict", "not_found", "uncertain", "uncertain", "uncertain"].sort());
  assert.equal(statuses.some(item => item.status === "completed"), false);
});
