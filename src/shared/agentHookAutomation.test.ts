import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentCompletionDeliveries, agentHookRuleErrors, agentHookConditionErrors, agentHookRuleEvents } from "./agentHookAutomation.js";

test("heartbeat exclusion persists without parameters and uses the same condition validation as the dialog", () => {
  const [rule] = normalizeAgentCompletionDeliveries([{ id: "heartbeat-filter", enabled: true, event: "task_completed",
    conditions: [{ type: "exclude_heartbeat" }], destination: { channel: "speech", gatewayId: "route", params: {} } }]);
  assert.deepEqual(rule.conditions, [{ type: "exclude_heartbeat" }]);
  assert.deepEqual(agentHookRuleErrors(rule), []);
  assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  assert.ok(agentHookRuleErrors({ ...rule, conditions: [...rule.conditions, ...rule.conditions] }).length);
  assert.deepEqual(agentHookConditionErrors({ type: "exclude_heartbeat" }), []);
  assert.ok(agentHookConditionErrors({ type: "project", path: "relative" }).length);
  assert.ok(agentHookConditionErrors({ type: "include_sessions", sessions: [] }).length);
});

test("event selections and formatting survive normalization across output channels", () => {
  for (const destination of [
    { channel: "speech", gatewayId: "route", params: {} },
    { channel: "napcat", gatewayId: "route", params: { instanceId: "qq", target: "group", targetId: "12345" } },
    { channel: "wecom", gatewayId: "route", params: { chatId: "room" } }
  ]) {
    const [rule] = normalizeAgentCompletionDeliveries([{ id: "list", enabled: true, event: "old",
      events: ["task_completed", "task_completed"], conditions: [],
      destination: { ...destination, params: { ...destination.params, includeAgentType: false, includeTaskName: "false" } } }]);
    assert.deepEqual(agentHookRuleEvents(rule), ["task_completed"]);
    assert.equal(rule.event, "task_completed");
    assert.equal(rule.destination.params.includeAgentType, "false");
    assert.equal(rule.destination.params.includeTaskName, "false");
    assert.deepEqual(agentHookRuleErrors(rule), []);
    assert.notEqual(agentHookRuleErrors({ ...rule, events: [] }).length, 0);
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  }
});

test("session condition normalization retains IDs and display names and rejects empty selections", () => {
  const base = { id: "rule", enabled: true, event: "task_completed",
    destination: { channel: "speech", gatewayId: "route", params: {} } };
  for (const type of ["include_sessions", "exclude_sessions"]) {
    const [rule] = normalizeAgentCompletionDeliveries([{ ...base, conditions: [{ type,
      sessions: [{ id: " first ", name: " Renamed task " }, { id: "first", name: "Current name" }, { id: "", name: "Invalid" }] }] }]);
    assert.deepEqual(rule.conditions, [{ type, sessions: [{ id: "first", name: "Current name" }] }]);
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
    assert.deepEqual(agentHookRuleErrors(rule), []);
    for (const sessions of [undefined, [], [{ id: "", name: "Invalid" }]]) {
      assert.ok(agentHookRuleErrors({ ...base, conditions: [{ type, sessions }] }).length);
    }
  }
});

test("legacy group rules migrate to one event, an AND condition list, and endpoint parameters", () => {
  const [rule] = normalizeAgentCompletionDeliveries([{ id: "saved-rule", enabled: true, projectPath: "C:/project",
    requireBoundPlan: true, gatewayId: "route", instanceId: "qq", groupId: "12345" }]);
  assert.deepEqual(rule, { id: "saved-rule", enabled: true, event: "task_completed",
    conditions: [{ type: "project", path: "C:/project" }, { type: "bound_plan" }],
    destination: { channel: "napcat", gatewayId: "route", params: { target: "group", targetId: "12345", instanceId: "qq" } } });
  assert.deepEqual(agentHookRuleErrors(rule), []);
  assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  assert.equal("projectPath" in rule, false);
  assert.equal("requireBoundPlan" in rule, false);
});

test("conditions and endpoint-specific parameters fail closed without imposing QQ fields on speech", () => {
  const base = { id: "rule", enabled: true, event: "task_completed", conditions: [],
    destination: { channel: "speech", gatewayId: "route", params: {} } };
  assert.deepEqual(agentHookRuleErrors(base), []);
  for (const change of [
    { event: "unknown" }, { conditions: [{ type: "unknown" }] },
    { conditions: [{ type: "project", path: "relative" }] },
    { conditions: [{ type: "bound_plan" }, { type: "bound_plan" }] },
    { destination: { channel: "napcat", gatewayId: "route", params: {} } }
  ]) assert.ok(agentHookRuleErrors({ ...base, ...change }).length);
  const [invalid] = normalizeAgentCompletionDeliveries([{ ...base, conditions: [{ type: "future-condition" }] }]);
  assert.ok(agentHookRuleErrors(invalid).length, "unknown conditions cannot become an unconditional rule");
  assert.deepEqual(agentHookRuleErrors({ ...base, destination: { channel: "napcat", gatewayId: "route",
    params: { target: "private", targetId: "67890", instanceId: "qq" } } }), []);
});


test("file delivery setting survives configuration normalization including explicit opt out", () => {
  for (const includeFiles of ["true", "false"]) {
    const [rule] = normalizeAgentCompletionDeliveries([{ id: "files", enabled: true, event: "task_completed", conditions: [],
      destination: { channel: "napcat", gatewayId: "route", params: { target: "group", targetId: "123", instanceId: "qq", includeFiles } } }]);
    assert.equal(rule.destination.params.includeFiles, includeFiles);
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  }
});


test("table rendering setting persists through normalization with boolean and string opt out", () => {
  for (const renderTables of [true, false, "true", "false"]) {
    const [rule] = normalizeAgentCompletionDeliveries([{id:"tables",enabled:true,event:"task_completed",conditions:[],destination:{channel:"napcat",gatewayId:"route",params:{target:"group",targetId:"123",instanceId:"qq",renderTables}}}]);
    assert.equal(rule.destination.params.renderTables, String(renderTables));
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  }
});

test("diagram rendering opt out persists through Hook normalization", () => {
  for (const renderDiagrams of ["true", "false"]) {
    const [rule] = normalizeAgentCompletionDeliveries([{id:"diagrams",enabled:true,event:"task_completed",conditions:[],destination:{channel:"napcat",gatewayId:"route",params:{target:"group",targetId:"123",instanceId:"qq",renderDiagrams}}}]);
    assert.equal(rule.destination.params.renderDiagrams, renderDiagrams);
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  }
});
