import assert from "node:assert/strict";
import test from "node:test";
import { automationQqTarget, automationQqDirectory, automationRuleConversation, automationPrivateContactChoices, automationQqContactChoices } from "../../src/plugins/io.rabiroute.manager.persona/web/persona/automationRuleConversation";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { parse } from "@vue/compiler-sfc";
import { computed, ref } from "vue";
import type { PersonaAutomationRuleDefinition } from "../src/types";

const route = { routeId: "route-a", instanceId: "napcat-a", name: "A" };
function rule(kinds: string[], fields: Record<string, unknown> = {}): PersonaAutomationRuleDefinition {
  return { id: "rule", trigger: { type: "message", routeKinds: kinds, ...fields }, action: { type: "deliver_agent" } };
}
function directory(routeId = "route-a", instanceId = "napcat-a", accountId = "10001", name = "Group A") {
  return { routeId, instanceId, accountId, entries: [
    { kind: "group" as const, target: "20001", name },
    { kind: "private" as const, target: "30001", name: "Friend A" }
  ] };
}

test("only one explicit QQ conversation is eligible for an avatar", () => {
  assert.deepEqual(automationQqTarget(rule(["group_message", "direct_at"], { targetGroupId: "20001" })), { kind: "group", id: "20001" });
  assert.deepEqual(automationQqTarget(rule(["private"], { targetUserId: "30001" })), { kind: "private", id: "30001" });
  for (const value of [rule([], { targetGroupId: "20001" }), rule(["private", "group_message"], { targetGroupId: "20001" }),
    rule(["wecom_message"], { targetGroupId: "20001" }), rule(["private"], { allowedSpeakerNames: ["30001"] }),
    rule(["private"], { regex: "30001" }), rule(["private"], { targetUserId: "Friend A" }),
    rule(["private"], { targetUserId: "30001", targetGroupId: "20001" })]) assert.equal(automationQqTarget(value), undefined);
});

test("directory ownership requires the requested instance and a verified account", () => {
  const raw = { instanceId: "napcat-a", account: { userId: "10001" }, entries: directory().entries };
  assert.deepEqual(automationQqDirectory(route, raw), directory());
  assert.equal(automationQqDirectory(route, { ...raw, instanceId: "foreign" }), undefined);
  assert.equal(automationQqDirectory(route, { ...raw, account: {} }), undefined);
  assert.deepEqual(automationQqDirectory(route, { ...raw, warnings: ["QQ_GROUP_LIST_UNAVAILABLE"] })?.entries,
    [{ kind: "private", target: "30001", name: "Friend A" }]);
});

test("a scoped group uses its actual directory name without matching another group's alias", () => {
  const scoped = rule(["group_message"], { targetGroupId: "20001" });
  scoped.sourceRouteIds = ["route-a"];
  const before = JSON.stringify(scoped);
  const foreign = { ...directory("route-b", "napcat-b"), entries: [{ kind: "group" as const, target: "20002", name: "Group A" }] };
  assert.deepEqual(automationRuleConversation(scoped, [route], [directory(), foreign]), { kind: "group", id: "20001", name: "Group A" });
  assert.equal(JSON.stringify(scoped), before);
  assert.equal(automationRuleConversation(scoped, [{ ...route, instanceId: "replacement" }], [directory()]), undefined);
});

test("unresolved routes never reuse another account's matching title", () => {
  const broad = rule(["group_message"], { targetGroupId: "20001" });
  const routes = [route, { routeId: "route-b", instanceId: "napcat-b", name: "B" }];
  assert.equal(automationRuleConversation(broad, routes, [directory()]), undefined);
  broad.sourceRouteIds = ["missing-route"];
  assert.equal(automationRuleConversation(broad, routes, [directory()]), undefined);
});

test("one QQ ID may span accounts but differing aliases fall back to that ID", () => {
  const broad = rule(["group_message"], { targetGroupId: "20001" });
  const routes = [route, { routeId: "route-b", instanceId: "napcat-b", name: "B" }];
  assert.deepEqual(automationRuleConversation(broad, routes, [directory(), directory("route-b", "napcat-b", "10002", "Other alias")]),
    { kind: "group", id: "20001", name: "20001" });
});

test("private cards and choices retain stable user IDs across duplicate names", () => {
  const privateRule = rule(["private"], { targetUserId: "30001" });
  const snapshot = directory();
  snapshot.entries.push({ kind: "private", target: "30002", name: "Friend A" });
  assert.deepEqual(automationRuleConversation(privateRule, [route], [snapshot]), { kind: "private", id: "30001", name: "Friend A" });
  assert.deepEqual(automationPrivateContactChoices(privateRule, [route], [snapshot]), [
    { title: "Friend A · 30001", value: "30001" }, { title: "Friend A · 30002", value: "30002" }
  ]);
});


test("group choices use scoped group IDs and keep same-name groups distinct from private contacts", () => {
  const groupRule = rule(["group_message"]);
  groupRule.sourceRouteIds = ["route-a"];
  const snapshot = directory();
  snapshot.entries.push({ kind: "group", target: "20002", name: "Group A" });
  const original = JSON.stringify(groupRule);
  assert.deepEqual(automationQqContactChoices("group", groupRule, [route], [snapshot]), [
    { title: "Group A · 20001", value: "20001" }, { title: "Group A · 20002", value: "20002" }
  ]);
  assert.equal(JSON.stringify(groupRule), original);
});

test("group choices obey source scope and resolve conflicting account aliases by number", () => {
  const groupRule = rule(["group_message"]);
  const routes = [route, { routeId: "route-b", instanceId: "napcat-b", name: "B" }];
  assert.deepEqual(automationQqContactChoices("group", groupRule, routes, [directory(), directory("route-b", "napcat-b", "10002", "Other alias")]),
    [{ title: "20001", value: "20001" }]);
  groupRule.sourceRouteIds = ["route-a"];
  assert.deepEqual(automationQqContactChoices("group", groupRule, routes, [directory()]), [{ title: "Group A · 20001", value: "20001" }]);
  groupRule.sourceRouteIds = ["unresolved"];
  assert.deepEqual(automationQqContactChoices("group", groupRule, routes, [directory()]), []);
});

const pickerPage = readFileSync(new URL("../../src/plugins/io.rabiroute.manager.persona/web/pages/PersonaTemplatePage.vue", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const pickerScript = parse(pickerPage).descriptor.scriptSetup!.content;
const pickerAst = ts.createSourceFile("picker.ts", pickerScript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const emit = (value: string) => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

test("actual group picker handler retains manual numbers, clears deliberately, and never saves a name as an ID", () => {
  const declaration = pickerAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "setAutomationGroupTarget");
  assert.ok(declaration);
  const patches: any[] = [];
  const handler = new Function("patchAutomationMessageTrigger", emit(declaration.getText(pickerAst)) + ";return setAutomationGroupTarget;")((patch: unknown) => patches.push(patch));
  handler("20001"); handler(" 29999 "); handler("Group A"); handler(null);
  assert.deepEqual(patches, [
    { targetGroupId: "20001", targetUserId: "" },
    { targetGroupId: "29999", targetUserId: "" },
    { targetGroupId: "", targetUserId: "" }
  ]);
  assert.ok(patches.every(patch => !("routeKinds" in patch)), "choosing a group preserves the user's trigger kinds");
});

test("actual picker choices retain an unresolved configured group through directory loading", () => {
  let declaration: ts.VariableDeclaration | undefined;
  for (const node of pickerAst.statements) if (ts.isVariableStatement(node)) {
    declaration = node.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === "automationGroupChoices");
    if (declaration) break;
  }
  assert.ok(declaration?.initializer);
  const active = ref(rule(["group_message"], { targetGroupId: "29999" }));
  const routes = ref([route]), directories = ref<any[]>([]);
  const choices = new Function("computed", "automationQqContactChoices", "activeAutomation", "automationQqRoutes", "automationQqDirectories",
    emit("const choices = " + declaration.initializer.getText(pickerAst) + ";") + "return choices;")
    (computed, automationQqContactChoices, active, routes, directories);
  assert.deepEqual(choices.value, [{ title: "29999", value: "29999" }]);
  directories.value = [directory()];
  assert.equal(choices.value[0].value, "29999");
  assert.equal(choices.value[1].value, "20001");
  active.value.trigger = { type: "message", routeKinds: ["group_message"], targetGroupId: "20001" };
  assert.deepEqual(choices.value, [{ title: "Group A · 20001", value: "20001" }]);
});

test("the group picker renders avatars in options and selection while accepting stable string values", () => {
  const start = pickerPage.indexOf('<v-combobox\n                        v-if="activeMessageTrigger?.routeKinds?.some(kind =>');
  const end = pickerPage.indexOf("</v-combobox>", start);
  assert.ok(start > 0 && end > start);
  const template = pickerPage.slice(start, end);
  assert.match(template, /:return-object="false"/);
  assert.match(template, /#item=/); assert.match(template, /#selection=/);
  assert.equal((template.match(/<QqAvatar/g) || []).length, 2);
  assert.match(template, /kind="group"/);
});
