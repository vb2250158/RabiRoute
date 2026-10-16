import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { changeDeliveryType, changeSendMode, chooseDeliverySession, chooseSenderIdentity, deliverySessions, senderIdentities, type DeliverySession, type SessionTarget } from "../src/components/automationAgentTargetModel";

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

test("missing group identity stays an incomplete group identity target, never a private fallback", () => {
  const incomplete = changeSendMode(changeDeliveryType(target(), "group"), "identity");
  assert.equal(incomplete.deliveryType, "group");
  assert.equal(incomplete.sendMode, "identity");
  assert.equal(incomplete.sessionId, "");
  assert.equal(incomplete.senderAgentId, undefined);
});

test("native roster kinds, title-only rows and complete IDs survive selection", () => {
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
  const source = readFileSync(new URL("../src/components/AutomationAgentTarget.vue", import.meta.url), "utf8");
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const script = compileScript(descriptor, { id: "automation-agent-target" });
  const template = compileTemplate({ source: descriptor.template!.content, filename: "AutomationAgentTarget.vue", id: "automation-agent-target", compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const controls = ["selectAgent", "selectDeliveryType", "selectSession", "selectSendMode", "selectIdentity"];
  const markup = descriptor.template!.content;
  assert.deepEqual(controls.map(control => markup.indexOf(`@update:model-value="${control}"`)),
    controls.map(control => markup.indexOf(`@update:model-value="${control}"`)).sort((first, second) => first - second));
  assert.match(source, /action: "list"/);
  assert.doesNotMatch(source, /\/api\/scan|fetch\(/);
  assert.match(source, /群消息指定身份发送必须选择群成员身份/);
  assert.match(source, /identityGeneration !== requestGeneration/);
  assert.match(source, /generation !== requestGeneration/);
});
