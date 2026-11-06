import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateLegacyConfigs, migrateScheduledAutomationConnector } from "./configMigration.js";
import { gatewayMessageAdapterTypes, gatewayRuntimeAdapterTypes, normalizePersonaAutomationRules, type GatewayDefinition } from "../shared/gatewayConfigModel.js";

function rule(id = "scheduled", sourceRouteIds?: string[]) {
  return { id, sourceRouteIds, trigger: { type: "schedule", schedule: { id: "original-time", type: "interval", intervalSeconds: 37 } }, action: { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" }, message: "original content" } };
}
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-schedule-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { routeRoot: path.join(root, "route"), rolesRoot: path.join(root, "roles") };
  function write(file: string, value: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
  const persona = path.join(options.rolesRoot, "Example", "personaConfig.json");
  function route(id: string, extra = {}) { const file = path.join(options.routeRoot, id, "adapterConfig.json"); write(file, { agentRoleId: "Example", gatewayPort: 21000 + id.length, messageAdapters: ["heartbeat"], ...extra }); return file; }
  return { options, write, route, persona, read: (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) };
}

test("schedule worker requires no message connector and respects rule/source/profile scope", () => {
  const gateway = { id: "main", automationScheduleSchemaVersion: 1, messageAdapters: [], automationRules: [rule()] } as unknown as GatewayDefinition;
  assert.deepEqual(gatewayRuntimeAdapterTypes(gateway), ["heartbeat"]);
  assert.deepEqual(gatewayRuntimeAdapterTypes({ ...gateway, automationScheduleSchemaVersion: undefined }), []);
  assert.deepEqual(gatewayRuntimeAdapterTypes({ ...gateway, automationScheduleSchemaVersion: undefined, messageAdapters: ["heartbeat"] }), ["heartbeat"]);
  assert.deepEqual(gatewayMessageAdapterTypes(gateway, new Set(["heartbeat"])), ["heartbeat"]);
  assert.deepEqual(gatewayMessageAdapterTypes(gateway, new Set()), []);
  assert.deepEqual(gatewayRuntimeAdapterTypes({ ...gateway, automationRules: [{ ...gateway.automationRules![0], enabled: false }] }), []);
  assert.deepEqual(gatewayRuntimeAdapterTypes({ ...gateway, automationRules: [rule("scoped", ["other"])] as any }), []);
  assert.deepEqual(gatewayRuntimeAdapterTypes({ ...gateway, routeProfiles: [{ id: "remote", agentRoleDeviceId: "remote-pc", automationRules: gateway.automationRules }] }), []);
  assert.deepEqual(gatewayRuntimeAdapterTypes({ id: "main", messageAdapters: ["heartbeat"] } as GatewayDefinition), []);
});

test("migration retains original active scope, ID, schedule, message, explicit off and busy inheritance", t => {
  const f = fixture(t);
  f.write(f.persona, { custom: "keep", automationRules: [rule(), rule("restricted", ["off", "absent"]), { ...rule("already-off"), enabled: false }] });
  const one = f.route("one", { enabled: false, heartbeatSkipWhenAgentBusy: true });
  f.route("two", { heartbeatSkipWhenAgentBusy: false });
  f.route("off", { messageAdaptersDisabled: ["heartbeat"] });
  migrateScheduledAutomationConnector(f.options);
  const value = f.read(f.persona);
  assert.equal(value.custom, "keep");
  assert.equal(value.automationScheduleSchemaVersion, 1);
  const [shared, restricted, off] = value.automationRules;
  assert.deepEqual(shared.sourceRouteIds, ["one", "two"]);
  assert.equal(shared.id, "scheduled");
  assert.equal(shared.trigger.schedule.intervalSeconds, 37);
  assert.equal(shared.trigger.schedule.skipWhenAgentBusy, undefined);
  assert.equal(shared.action.message, "original content");
  assert.equal(restricted.enabled, true);
  assert.deepEqual(restricted.sourceRouteIds, ["absent"]);
  assert.equal(off.enabled, false);
  assert.equal(f.read(one).heartbeatSkipWhenAgentBusy, true);
  assert.deepEqual(f.read(one).messageAdapters, []);
  const before = fs.readFileSync(f.persona);
  migrateScheduledAutomationConnector(f.options);
  assert.deepEqual(fs.readFileSync(f.persona), before);
  // A later explicit Automation edit is never disabled by retired connector state.
  value.automationRules.push(rule("new-rule")); f.write(f.persona, value);
  migrateScheduledAutomationConnector(f.options);
  assert.notEqual(f.read(f.persona).automationRules.at(-1).enabled, false);
});

test("disabled connector cannot awaken old schedules; uniform busy value becomes editable rule parameter", t => {
  const f = fixture(t);
  f.write(f.persona, { automationRules: [rule()] });
  f.route("main", { messageInputsDisabled: true });
  migrateScheduledAutomationConnector(f.options);
  assert.equal(f.read(f.persona).automationRules[0].enabled, false);
});

test("schedule normalization preserves explicit false, true and legacy inheritance", () => {
  const normalized = normalizePersonaAutomationRules([undefined, false, true].map((skipWhenAgentBusy, i) => ({ ...rule(String(i)), trigger: { type: "schedule", schedule: { ...rule().trigger.schedule, skipWhenAgentBusy } } })));
  assert.deepEqual(normalized.map(item => item.trigger.type === "schedule" ? item.trigger.schedule.skipWhenAgentBusy : null), [undefined, false, true]);
});


test("explicit maintenance preview is read-only, apply snapshots and restart preserves migrated route scope", async t => {
  const f = fixture(t);
  f.write(f.persona, { customExtension: "preserved", automationRules: [rule()] });
  f.route("one", { heartbeatSkipWhenAgentBusy: true, codexThreadId: "original-task", privateExtension: "preserved" });
  f.route("off", { messageAdaptersDisabled: ["heartbeat"] });
  const original = fs.readFileSync(f.persona);
  const { upgradePersonaMessageConfig, restorePersonaMessageConfig } = await import("./personaConfigUpgrade.js");
  const root = path.dirname(f.options.routeRoot);
  const preview = upgradePersonaMessageConfig({ mode: "scheduled_automation", root, routeRoot: f.options.routeRoot, rolesRoot: f.options.rolesRoot });
  assert.ok(preview.changedFiles > 0);
  assert.deepEqual(fs.readFileSync(f.persona), original);
  const applied = upgradePersonaMessageConfig({ mode: "scheduled_automation", root, routeRoot: f.options.routeRoot, rolesRoot: f.options.rolesRoot, apply: true, offline: true });
  assert.equal(applied.applied, true);
  assert.ok(applied.snapshot);
  const { ManagerConfigRepository } = await import("./configRepository.js");
  const repo = new ManagerConfigRepository({ rootDir: root, ...f.options, managerPort: 0 });
  const loaded = repo.readConfig().gateways;
  assert.equal(loaded.find(route => route.id === "one")?.automationScheduleSchemaVersion, 1);
  assert.deepEqual(gatewayRuntimeAdapterTypes(loaded.find(route => route.id === "one")!), ["heartbeat"]);
  assert.deepEqual(gatewayRuntimeAdapterTypes(loaded.find(route => route.id === "off")!), []);
  const migratedSchedule = f.read(f.persona).automationRules.find((item: any) => item.trigger.type === "schedule");
  assert.ok(migratedSchedule, JSON.stringify(f.read(f.persona).automationRules));
  assert.equal(migratedSchedule.id, "scheduled");
  assert.deepEqual(migratedSchedule.action.target, { kind: "recipient", recipientId: "primary" });
  assert.equal(f.read(f.persona).agentDeliveryConfigurationVersion, undefined, "Dedicated mode does not run Agent delivery migration");
  assert.equal(f.read(f.persona).automationRules.length, 1, "Dedicated mode does not backfill unrelated built-in automations");
  assert.equal(f.read(f.persona).customExtension, "preserved");
  const routeOne = f.read(path.join(f.options.routeRoot, "one", "adapterConfig.json"));
  assert.equal(routeOne.codexThreadId, "original-task");
  assert.equal(routeOne.privateExtension, "preserved");
  assert.equal(migratedSchedule.trigger.schedule.skipWhenAgentBusy, true);
  const again = upgradePersonaMessageConfig({ mode: "scheduled_automation", root, routeRoot: f.options.routeRoot, rolesRoot: f.options.rolesRoot });
  assert.equal(again.changedFiles, 0);
  restorePersonaMessageConfig(applied.snapshot!, true);
  assert.deepEqual(fs.readFileSync(f.persona), original);
});


test("whole legacy migration keeps raw interval and the actual scheduled body rather than unused card text", t => {
  const f = fixture(t);
  f.write(f.persona, { agentDeliveryConfigurationVersion: 1, notificationRules: [{ id: "巡检", name: "旧巡检", routeKinds: ["heartbeat"], enabled: true, template: "旧模板" }] });
  f.route("main", { heartbeatIntervalSeconds: 60, heartbeatMessage: "旧卡片正文" });
  migrateLegacyConfigs(f.options);
  const scheduled = f.read(f.persona).automationRules.filter((item: any) => item.trigger.type === "schedule");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].id, "scheduled-巡检-legacy-interval");
  assert.equal(scheduled[0].trigger.schedule.intervalSeconds, 60);
  assert.equal(scheduled[0].action.message, "定时计划触发：旧巡检 / 旧巡检");
  assert.equal(scheduled[0].action.template, "旧模板");
  assert.deepEqual(scheduled[0].sourceRouteIds, ["main"]);
  const before = fs.readFileSync(f.persona); migrateLegacyConfigs(f.options);
  assert.deepEqual(fs.readFileSync(f.persona), before);
});

test("different legacy Route intervals become scoped stable rules without overwriting an explicit automation", t => {
  const f = fixture(t);
  f.write(f.persona, { notificationRules: [{ id: "timer", routeKinds: ["heartbeat"], template: "legacy" }] });
  f.route("one", { heartbeatIntervalSeconds: 60 }); f.route("two", { heartbeatIntervalSeconds: 120 });
  migrateLegacyConfigs(f.options);
  const rules = f.read(f.persona).automationRules.filter((item: any) => item.trigger.type === "schedule");
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((item: any) => [item.sourceRouteIds, item.trigger.schedule.intervalSeconds]), [[["one"], 60], [["two"], 120]]);
  assert.equal(rules[0].id, "scheduled-timer-legacy-interval"); assert.match(rules[1].id, /^scheduled-timer-legacy-interval-schedule-[0-9a-f]{10}$/);
});


test("nested profile legacy schedules preserve per-Route intervals, disabled tasks and original source restrictions", t => {
  const f = fixture(t); f.write(f.persona, { automationRules: [] });
  const notificationRules = [{ id: "nested", routeKinds: ["heartbeat"], sourceRouteIds: ["one", "two", "unavailable"], template: "nested original" }];
  for (const [id, interval] of [["one", 60], ["two", 120]] as const) f.route(id, { heartbeatIntervalSeconds: interval,
    routeProfiles: [{ id: `original-task-${id}`, agentRoleId: "Example", notificationRules },
      { id: "disabled-task", agentRoleId: "Example", enabled: false, notificationRules: [{ id: "off-profile", routeKinds: ["heartbeat"] }] }] });
  f.route("foreign", { heartbeatIntervalSeconds: 240, routeProfiles: [{ id: "original-foreign-task", agentRoleId: "Example", notificationRules }] });
  migrateLegacyConfigs(f.options);
  const rules = f.read(f.persona).automationRules.filter((item: any) => item.trigger.type === "schedule");
  const active = rules.filter((item: any) => item.id.startsWith("scheduled-nested"));
  assert.equal(active.length, 2);
  assert.deepEqual(active.map((item: any) => [item.sourceRouteIds, item.trigger.schedule.intervalSeconds]), [[["one"], 60], [["two"], 120]]);
  assert.ok(rules.filter((item: any) => item.id.startsWith("scheduled-off-profile")).every((item: any) => item.enabled === false));
  assert.ok(active.every((item: any) => item.action.template === "nested original"));
  assert.ok(active.every((item: any) => !item.sourceRouteIds.includes("foreign")));
  const before = fs.readFileSync(f.persona); migrateLegacyConfigs(f.options); assert.deepEqual(fs.readFileSync(f.persona), before);
});


test("dedicated mode requires modern structured rules and restores every file after partial failure", async t => {
  const f = fixture(t); f.write(f.persona, { automationRules: [rule()] }); const route = f.route("main");
  const { upgradePersonaMessageConfig } = await import("./personaConfigUpgrade.js");
  const options = { root: path.dirname(f.options.routeRoot), ...f.options, mode: "scheduled_automation" as const };
  const beforePersona = fs.readFileSync(f.persona); const beforeRoute = fs.readFileSync(route);
  assert.throws(() => upgradePersonaMessageConfig({ ...options, apply: true, offline: true,
    beforeWrite(index) { if (index === 1) throw new Error("injected schedule migration write failure"); } }), /restored/);
  assert.deepEqual(fs.readFileSync(f.persona), beforePersona); assert.deepEqual(fs.readFileSync(route), beforeRoute);
  f.write(f.persona, { notificationRules: [{ id: "legacy", routeKinds: ["heartbeat"] }] });
  const legacy = fs.readFileSync(f.persona);
  assert.throws(() => upgradePersonaMessageConfig(options), /Legacy persona rules require --mode full/);
  assert.deepEqual(fs.readFileSync(f.persona), legacy);
});


test("dedicated schedule migration preserves unrelated message rule contents and user extensions", t => {
  const f = fixture(t);
  const messageRule = { id: "message-original", customExtension: { keep: true }, enabled: false,
    trigger: { type: "message", routeKinds: ["private"], regex: "original" },
    action: { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" }, template: "original template" } };
  f.write(f.persona, { automationRules: [messageRule, { ...rule(), customExtension: "schedule-keep" }] }); f.route("main");
  migrateScheduledAutomationConnector(f.options);
  const rules = f.read(f.persona).automationRules;
  assert.deepEqual(rules[0], messageRule);
  assert.equal(rules[1].customExtension, "schedule-keep");
});


test("v2 preserves unavailable original scopes, removes known disabled sources and never creates an all-Route scope", t => {
  const f = fixture(t);
  const inputs = [rule("mixed", ["one", "off", "unknown-original-route"]), rule("only-off", ["off"]),
    rule("only-unknown", ["unknown-original-route"]), { ...rule("explicitly-disabled", ["one", "unknown-original-route"]), enabled: false }];
  f.write(f.persona, { automationRules: inputs });
  f.route("one", { heartbeatSkipWhenAgentBusy: true }); f.route("off", { messageAdaptersDisabled: ["heartbeat"] });
  migrateScheduledAutomationConnector(f.options);
  const [mixed, off, unknown, disabled] = f.read(f.persona).automationRules;
  assert.deepEqual(mixed.sourceRouteIds, ["one", "unknown-original-route"]); assert.equal(mixed.enabled, true);
  assert.equal(mixed.trigger.schedule.skipWhenAgentBusy, undefined, "An unknown original source keeps per-Route busy inheritance");
  assert.deepEqual(off.sourceRouteIds, ["off"]); assert.equal(off.enabled, false);
  assert.deepEqual(unknown.sourceRouteIds, ["unknown-original-route"]); assert.equal(unknown.enabled, true);
  assert.deepEqual(disabled.sourceRouteIds, ["one", "unknown-original-route"]); assert.equal(disabled.enabled, false);
  const bytes = fs.readFileSync(f.persona); migrateScheduledAutomationConnector(f.options); assert.deepEqual(fs.readFileSync(f.persona), bytes);
});

test("v2 preserves a nonempty unknown-only scope when no Route configuration is available", t => {
  const f = fixture(t); f.write(f.persona, { automationRules: [rule("recover-original", ["unknown-original-route"])] });
  migrateScheduledAutomationConnector(f.options);
  const value = f.read(f.persona).automationRules[0];
  assert.deepEqual(value.sourceRouteIds, ["unknown-original-route"]); assert.equal(value.enabled, true);
});

test("v2 dedicated mode changes only schedule controls and preserves nested action and target extensions", async t => {
  const f = fixture(t);
  const action = { type: "deliver_agent", message: "unchanged", template: "original template", customActionExtension: { keep: true, nested: [1, { x: "original" }] },
    target: { kind: "recipient", recipientId: "primary", customTargetExtension: { keep: "target-original" } } };
  const original = { ...rule("original-rule", ["main", "unknown-original-route"]), action,
    customRuleExtension: { original: true }, trigger: { type: "schedule", customTriggerExtension: "original-trigger",
      schedule: { ...rule().trigger.schedule, customScheduleExtension: { original: ["original"] } } } };
  f.write(f.persona, { automationRules: [original] }); f.route("main");
  const { upgradePersonaMessageConfig, restorePersonaMessageConfig } = await import("./personaConfigUpgrade.js");
  const options = { root: path.dirname(f.options.routeRoot), ...f.options, mode: "scheduled_automation" as const };
  const before = fs.readFileSync(f.persona); const preview = upgradePersonaMessageConfig(options);
  assert.ok(preview.changedFiles > 0); assert.deepEqual(fs.readFileSync(f.persona), before);
  const applied = upgradePersonaMessageConfig({ ...options, apply: true, offline: true });
  const migrated = f.read(f.persona).automationRules[0];
  assert.equal(migrated.id, "original-rule"); assert.deepEqual(migrated.action, action);
  assert.deepEqual(migrated.sourceRouteIds, ["main", "unknown-original-route"]);
  assert.deepEqual(migrated.customRuleExtension, original.customRuleExtension);
  assert.equal(migrated.trigger.customTriggerExtension, "original-trigger");
  assert.deepEqual(migrated.trigger.schedule.customScheduleExtension, original.trigger.schedule.customScheduleExtension);
  restorePersonaMessageConfig(applied.snapshot!, true); assert.deepEqual(fs.readFileSync(f.persona), before);
});
