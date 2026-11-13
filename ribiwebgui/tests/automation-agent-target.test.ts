import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { availableAutomationDsh, automationDsBotDirectory, dsBotDirectoryTargets, chooseDsBot, readDsBotCatalog, changeDeliveryType, changeSendMode, chooseDeliverySession, chooseSenderIdentity, deliverySessions, isGroupSession, senderIdentities, type DeliverySession, type SessionTarget } from "../../src/plugins/io.rabiroute.manager.persona/web/components/automationAgentTargetModel";

const room = { id: "grokBot:full-room-session-id", name: "Example group", kind: "GROK_BOT_AGENT_KIND_ROOM", memberAgentIds: ["member-a"] };
const member: DeliverySession = { id: "member-session", name: "Member", kind: "AGENT", nativeAgentId: "member-a" };
const outsider: DeliverySession = { id: "other-session", name: "Other", kind: "AGENT", nativeAgentId: "member-b" };
const rows = [room, member, outsider, { id: "legacy", name: "Legacy session" }];
function target(): SessionTarget {
  return { kind: "session", agentTargetId: "local:grokBot", agentAdapter: "grokBot", sessionId: room.id,
    sessionName: room.name, workspace: "", deliveryType: "group", sendMode: "identity", senderAgentId: "member-a", senderAgentName: "Member" };
}

test("group targets contain only native rooms; private and other Agents retain session semantics", () => {
  assert.deepEqual(deliverySessions(rows, target()), [room]);
  assert.deepEqual(deliverySessions(rows, { ...target(), deliveryType: "private" }), rows.slice(1));
  assert.deepEqual(deliverySessions(rows, { ...target(), agentAdapter: "codex" }), rows);
  assert.equal(chooseDeliverySession(target(), member), undefined);
  assert.equal(chooseDeliverySession({ ...target(), deliveryType: "private" }, room), undefined);
});

test("group identity is a non-room native owner in the selected group's member set", () => {
  assert.deepEqual(senderIdentities([...rows, { ...member, id: "duplicate" }], room), [ { ...member, id: "duplicate" } ]);
  assert.deepEqual(senderIdentities(rows), []);
  assert.deepEqual(senderIdentities(rows, { ...room, memberAgentIds: [] }), []);
  assert.equal(chooseSenderIdentity(target(), rows, room, "member-b"), undefined);
  assert.equal(chooseSenderIdentity(target(), rows, undefined, "member-a"), undefined);
  assert.equal(chooseSenderIdentity(target(), rows, room, member.id), undefined);
  assert.equal(chooseSenderIdentity(target(), rows, room, "member-a")?.senderAgentId, "member-a");
  assert.equal(chooseSenderIdentity(target(), [{ ...member, title: "Member session", nativeAgentName: "Member identity" }], room, "member-a")?.senderAgentName, "Member identity");
  assert.deepEqual(senderIdentities(rows, undefined, false), [member, outsider]);
});

test("type, mode and room changes clear stale identities without mutating their input", () => {
  const original = target();
  const privateTarget = changeDeliveryType(original, "private");
  assert.equal(privateTarget.sessionId, "");
  assert.equal(privateTarget.sendMode, "direct");
  assert.equal("senderAgentId" in privateTarget, false);
  const direct = changeSendMode(original, "direct");
  assert.equal(direct.sessionId, room.id);
  assert.equal("senderAgentName" in direct, false);
  assert.equal(chooseSenderIdentity(direct, rows, room, "member-a"), undefined);
  const nextRoom = chooseDeliverySession(original, { ...room, id: "next-room" })!;
  assert.equal(nextRoom.deliveryType, "group");
  assert.equal(nextRoom.sendMode, "identity");
  assert.equal("senderAgentId" in nextRoom, false);
  assert.deepEqual(original, target());
});

test("editing a legacy Grok target materializes the displayed private/direct defaults", () => {
  const { deliveryType, sendMode, senderAgentId, senderAgentName, ...legacy } = target();
  assert.equal(changeSendMode(legacy, "identity").deliveryType, "private");
  const selected = chooseDeliverySession(legacy, member);
  assert.equal(selected?.deliveryType, "private");
  assert.equal(selected?.sendMode, "direct");
});

test("missing group identity stays an incomplete group identity target, never a private fallback", () => {
  const incomplete = changeSendMode(changeDeliveryType(target(), "group"), "identity");
  assert.equal(incomplete.deliveryType, "group");
  assert.equal(incomplete.sendMode, "identity");
  assert.equal(incomplete.sessionId, "");
  assert.equal(incomplete.senderAgentId, undefined);
});

test("native roster kinds, title-only rows and complete IDs survive selection", () => {
  for (const kind of ["ROOM", "GROK_BOT_AGENT_KIND_ROOM", 2, "2"]) {
    const numericRoom = { ...room, kind, nativeAgentId: "room-owner" };
    assert.equal(isGroupSession(numericRoom), true);
    assert.deepEqual(deliverySessions([numericRoom, member], target()), [numericRoom]);
    assert.deepEqual(deliverySessions([numericRoom, member], { ...target(), deliveryType: "private" }), [member]);
    assert.deepEqual(senderIdentities([numericRoom, member], { ...room, memberAgentIds: ["room-owner", "member-a"] }), [member]);
  }
  for (const kind of ["AGENT", "GROK_BOT_AGENT_KIND_AGENT", 1, "1", undefined]) {
    assert.equal(isGroupSession({ ...member, kind }), false);
  }
  const nativeRoom = { ...room, name: undefined, title: "Native group", nativeAgentId: "room-owner" };
  const nativeMember = { ...member, kind: "GROK_BOT_AGENT_KIND_AGENT", name: undefined, title: "Native member" };
  const selected = chooseDeliverySession(target(), nativeRoom)!;
  assert.equal(selected.sessionId, nativeRoom.id);
  assert.equal(selected.sessionName, "Native group");
  assert.deepEqual(deliverySessions([nativeRoom, nativeMember], target()), [nativeRoom]);
  assert.deepEqual(senderIdentities([nativeRoom, nativeMember], nativeRoom), [nativeMember]);
  const identity = chooseSenderIdentity(selected, [nativeMember], nativeRoom, "member-a")!;
  assert.equal(identity.senderAgentName, "Native member");
  assert.equal(identity.sessionId, nativeRoom.id);
});

test("component compiles, orders Grok controls, and uses the existing list client only", () => {
  const source = readFileSync(new URL("../../src/plugins/io.rabiroute.manager.persona/web/components/AutomationAgentTarget.vue", import.meta.url), "utf8");
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: "automation-agent-target" });
  const template = compileTemplate({ source: descriptor.template!.content, filename: "AutomationAgentTarget.vue", id: "automation-agent-target", compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const controls = ["selectAgent", "selectDeliveryType", "selectSession", "selectSendMode", "selectIdentity"];
  const markup = descriptor.template!.content;
  assert.match(markup, /:label="t\('会话类型'\)"/);
  assert.deepEqual(controls.map(control => markup.indexOf(`@update:model-value="${control}"`)),
    controls.map(control => markup.indexOf(`@update:model-value="${control}"`)).sort((first, second) => first - second));
  assert.match(source, /action: "list"/);
  assert.doesNotMatch(source, /\/api\/scan|fetch\(/);
  assert.match(source, /群消息指定身份发送必须选择群成员身份/);
  assert.match(source, /identityGeneration !== requestGeneration/);
  assert.match(source, /generation !== requestGeneration/);
});

test("DSBot selection saves scope and stable Bot identity instead of a Session or runtime", () => {
  const catalog = readDsBotCatalog({ schemaVersion: 1, botScopeId: "scope", runtimeId: "live", bots: [{ botId: "stable-bot", botName: "Bot", roleId: "unrelated" }] });
  const destination = chooseDsBot({ id: "remote:original:dsh", provider: "dsh", binding: { instanceId: "original", agentId: "dsh" } }, catalog, "stable-bot");
  assert.deepEqual(destination, { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "remote:original:dsh", botScopeId: "scope", botId: "stable-bot", botName: "Bot", instanceBinding: { instanceId: "original", agentId: "dsh" } });
  assert.equal(chooseDsBot({ id: "remote:original:dsh", provider: "dsh", binding: { instanceId: "original", agentId: "dsh" } }, catalog, "missing"), undefined);
  assert.equal(chooseDsBot({ id: "", provider: "dsh" }, catalog, "stable-bot"), undefined);
  assert.throws(() => readDsBotCatalog({ ...catalog, bots: [...catalog.bots, ...catalog.bots] }), /Invalid/);
  assert.throws(() => readDsBotCatalog({ ...catalog, botScopeId: "" }), /Invalid/);
});

test("independent roles discover DSH from published capabilities without primary configuration", async () => {
  const urls: string[] = [];
  const available = await availableAutomationDsh(async input => { urls.push(String(input)); return Response.json({ code: 0, data: { adapters: [{ type: "dsh", capabilities: { managedTasks: { agentThreads: true } } }] } }); });
  assert.equal(available, true); assert.deepEqual(urls, ["/api/agent-adapters/catalog"]);
  assert.equal(await availableAutomationDsh(async () => Response.json({ code: 0, data: { adapters: [{ type: "dsh", capabilities: { managedTasks: {} } }] } })), false);
  await assert.rejects(availableAutomationDsh(async () => Response.json({ code: -1 }, { status: 503 })), /unavailable/);
});

test("DSBot component retains saved destinations and fences asynchronous host or mode changes", () => {
  const source = readFileSync(new URL("../../src/plugins/io.rabiroute.manager.persona/web/components/AutomationAgentTarget.vue", import.meta.url), "utf8");
  assert.match(source, /action: "ds_bot_catalog"/);
  assert.match(source, /destinationMode.value !== value.kind/);
  assert.match(source, /if \(generation !== requestGeneration\) return;\r?\n      botCatalog.value = readDsBotCatalog/);
  assert.match(source, /catalog.botScopeId !== saved.botScopeId/);
  assert.match(source, /原 DSBot 在当前目录中不可用/);
  assert.match(source, /@update:model-value="selectDestinationMode"/);
  assert.match(source, /@update:model-value="selectBot"/);
});

test("connected remote catalogs expose real peer bindings without any Route", () => {
  const targets = dsBotDirectoryTargets([{ instanceId: "machine", ownerDeviceId: "peer", local: false, connected: true, agents: [{ agentId: "dsh-instance", name: "DSH", provider: "dsh", enabled: true }] }, { instanceId: "offline", local: false, connected: false, agents: [{ agentId: "dsh", name: "DSH", provider: "dsh", enabled: true }] }]);
  assert.deepEqual(targets, [{ id: "peer:peer:machine:dsh-instance", provider: "dsh", binding: { ownerDeviceId: "peer", instanceId: "machine", agentId: "dsh-instance" } }]);
  const catalog = readDsBotCatalog({ schemaVersion: 1, botScopeId: "scope", runtimeId: "live", dshBaseUrl: "http://127.0.0.1:4567", bots: [{ botId: "bot", botName: "Bot" }] });
  const remote = chooseDsBot(targets[0], catalog, "bot")!;
  assert.deepEqual(remote.instanceBinding, targets[0].binding); assert.equal(remote.dshBaseUrl, undefined);
  const local = chooseDsBot({ id: "local:dsh", provider: "dsh" }, catalog, "bot")!;
  assert.equal(local.dshBaseUrl, "http://127.0.0.1:4567"); assert.equal(local.instanceBinding, undefined);
});

test("DSBot directory follows the existing access-token handshake and isolates an unavailable source", async () => {
  const calls: string[] = [];
  const directory = await automationDsBotDirectory(async (input, init) => {
    const url = String(input); calls.push(url);
    if (url === "/api/webgui-access") return Response.json({ code: 0, data: { token: "fixture-directory-access" } });
    assert.equal(new Headers(init?.headers).get("x-rabiroute-webgui-token"), "fixture-directory-access");
    if (url === "/api/lan-agent/instances") return Response.json({ code: 0, instances: [{ instanceId: "remote", local: false, connected: true, agents: [{ agentId: "dsh", provider: "dsh", name: "DSH", enabled: true }] }] });
    if (url === "/meta") return Response.json({ rabiLinkRelay: { deviceId: "self" } });
    if (url === "/api/rabilink/peer/list") return Response.json({ peers: [] });
    return Response.json({ code: -1, message: "other source unavailable" }, { status: 503 });
  });
  assert.equal(calls[0], "/api/webgui-access");
  assert.equal(dsBotDirectoryTargets(directory.instances)[0].binding?.instanceId, "remote");
  assert.ok(directory.diagnostics.length > 0);
});

test("one malformed remote directory entry does not hide healthy DSH owners", () => {
  const targets = dsBotDirectoryTargets([null, { connected: true }, { instanceId: "bad identity!", connected: true, agents: [{ provider: "dsh", agentId: "dsh" }] }, { instanceId: "healthy", connected: true, local: false, agents: [null, { provider: "dsh", agentId: "dsh", enabled: true }] }] as unknown as import("../../src/shared/agentInstance").AgentInstance[]);
  assert.deepEqual(targets, [{ id: "remote:healthy:dsh", provider: "dsh", binding: { instanceId: "healthy", agentId: "dsh" } }]);
});

test("the actual Persona parent accepts an incomplete DSBot edit without poisoning draft projections", async () => {
  const { createRoleEditorActions } = await import("../../src/plugins/io.rabiroute.manager.persona/web/persona/roleEditorActions");
  const { automationRulesForGateway, hasIncompleteDsBotTargetDraft } = await import("../src/utils/gatewayHelpers");
  const gateway = { id: "fixture", gatewayPort: 0, automationScheduleSchemaVersion: 1, notificationRules: [], automationRules: [{ id: "task", trigger: { type: "schedule", schedule: { id: "daily", type: "daily_time", timeOfDay: "10:00" } }, action: { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" }, message: "Keep task", template: "Keep instructions" } }] } as import("../src/types").GatewayDefinition;
  const actions = createRoleEditorActions(() => gateway, () => {});
  const partial = { kind: "ds_bot" as const, agentAdapter: "dsh" as const, agentTargetId: "local:dsh", botScopeId: "", botId: "", botName: "" };
  assert.doesNotThrow(() => actions.updateAutomation("task", { action: { type: "deliver_agent", target: partial, message: "Keep task", template: "Keep instructions" } }));
  assert.doesNotThrow(() => automationRulesForGateway(gateway));
  const pending = automationRulesForGateway(gateway).find(rule => rule.id === "task")!;
  assert.equal(pending.action.type, "deliver_agent");
  if (pending.action.type === "deliver_agent") { assert.deepEqual(pending.action.target, partial); assert.equal(pending.action.message, "Keep task"); assert.equal(pending.action.template, "Keep instructions"); }
  assert.equal(hasIncompleteDsBotTargetDraft(gateway), true);
  const { normalizePersonaAutomationRules } = await import("../../src/shared/gatewayConfigModel");
  assert.throws(() => normalizePersonaAutomationRules(gateway.automationRules), /exact DSH/);
  for (const target of [
    { kind: "ds_bot" as const, agentAdapter: "dsh" as const, agentTargetId: "local:dsh", dshBaseUrl: "http://127.0.0.1:4567", botScopeId: "scope", botId: "bot", botName: "Bot" },
    { kind: "ds_bot" as const, agentAdapter: "dsh" as const, agentTargetId: "peer:device:machine:dsh", instanceBinding: { ownerDeviceId: "device", instanceId: "machine", agentId: "dsh" }, botScopeId: "scope", botId: "bot", botName: "Bot" }
  ]) {
    actions.updateAutomation("task", { action: { type: "deliver_agent", target, message: "Keep task", template: "Keep instructions" } });
    assert.equal(hasIncompleteDsBotTargetDraft(gateway), false);
    const completed = normalizePersonaAutomationRules(gateway.automationRules).find(rule => rule.id === "task")!;
    if (completed.action.type === "deliver_agent") assert.deepEqual(completed.action.target, target);
  }
  actions.updateAutomation("task", { action: { type: "deliver_agent", target: { ...partial, botScopeId: "scope", botId: "bot", botName: "Bot", dshBaseUrl: "http://127.0.0.1:4567/?token=private" }, message: "Keep task" } });
  assert.equal(hasIncompleteDsBotTargetDraft(gateway), true);
  assert.throws(() => normalizePersonaAutomationRules(gateway.automationRules), /clean connection origin/);
  const page = readFileSync(new URL("../../src/plugins/io.rabiroute.manager.persona/web/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
  assert.match(page, /ready: computed\([^\n]*!invalidDsBotTarget.value/);
  assert.match(page, /if \(invalidDsBotTarget.value\) throw new Error/);
});

test("an unfinished message target keeps its draft while healthy notification projections stay usable", async () => {
  const { createRoleEditorActions } = await import("../../src/plugins/io.rabiroute.manager.persona/web/persona/roleEditorActions");
  const { automationRulesForGateway, hasIncompleteDsBotTargetDraft } = await import("../src/utils/gatewayHelpers");
  const makeRule = (id: string) => ({ id, trigger: { type: "message" as const, routeKinds: ["private"] }, action: { type: "deliver_agent" as const, target: { kind: "recipient" as const, recipientId: "primary" }, message: id } });
  const gateway = { id: "fixture", gatewayPort: 0, notificationRules: [], automationRules: [makeRule("healthy"), makeRule("editing")] } as import("../src/types").GatewayDefinition;
  const actions = createRoleEditorActions(() => gateway, () => {});
  actions.updateAutomation("editing", { action: { type: "deliver_agent", target: { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", botScopeId: "", botId: "", botName: "" }, message: "unfinished target" } });
  assert.deepEqual(automationRulesForGateway(gateway).map(rule => rule.id), ["healthy", "editing"]);
  assert.deepEqual(gateway.notificationRules.map(rule => rule.id), ["healthy"]);
  assert.equal(hasIncompleteDsBotTargetDraft(gateway), true);
});
