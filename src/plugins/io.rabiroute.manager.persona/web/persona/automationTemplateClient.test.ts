import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { ref, toRaw } from "vue";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import { DEFAULT_AUTOMATION_TEMPLATES, BLANK_AUTOMATION_TEMPLATE_ID, automationTemplatePatch, loadAutomationTemplate, loadAutomationTemplates } from "./automationTemplateClient";
import { createRoleEditorActions } from "./roleEditorActions";
import type { GatewayDefinition } from "../../../../../ribiwebgui/src/types";

function pageHandlers(dependencies: Record<string, unknown>) {
  const filename = new URL("../pages/PersonaTemplatePage.vue", import.meta.url), source = fs.readFileSync(filename, "utf8");
  const parsed = parse(source); assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: "automation-template-test" });
  const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: filename.pathname, id: "automation-template-test", compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const ast = ts.createSourceFile("page.ts", script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), functions: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && ["createAutomation", "openAutomationTemplatePicker", "loadMoreAutomationTemplates"].includes(node.name.text)) functions.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.equal(functions.length, 3);
  const js = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const bound = { BLANK_AUTOMATION_TEMPLATE_ID, automationTemplateOwner: ref("original-role-source"), ...dependencies };
  return new Function(...Object.keys(bound), js + ";return {createAutomation,openAutomationTemplatePicker,loadMoreAutomationTemplates};")(...Object.values(bound));
}

test("template client reads small pages and fetches a selected custom body from the supplied source", async () => {
  const paths: string[] = [], custom = { ...DEFAULT_AUTOMATION_TEMPLATES[0], id: "io.example.custom" };
  const fetcher: typeof fetch = async input => {
    const path = String(input); paths.push(path);
    if (path.includes("?")) return Response.json({ code: 0, data: { items: [{ id: custom.id, title: custom.title }], nextCursor: "next-page", total: 2 } });
    return Response.json({ code: 0, data: { template: custom } });
  };
  const page = await loadAutomationTemplates(fetcher, new AbortController().signal, "old-page");
  assert.equal(page.nextCursor, "next-page"); assert.equal("action" in page.items[0], false);
  assert.deepEqual(await loadAutomationTemplate(fetcher, new AbortController().signal, custom.id), custom);
  assert.deepEqual(paths, ["/api/automation/templates?limit=20&cursor=old-page", "/api/automation/templates/io.example.custom"]);
});

test("real page template selection expands through the existing role store and preserves unrelated rules", async () => {
  const gateway = ref({ id: "Example", gatewayPort: 0, agentRoleId: "Example", automationScheduleSchemaVersion: 1, automationRules: [
    { id: "existing", name: "Keep existing", trigger: { type: "message", routeKinds: ["private"] }, action: { type: "deliver_agent", message: "User message" } }
  ] } as GatewayDefinition);
  let touches = 0, opened = "";
  const store = createRoleEditorActions(() => gateway.value, () => { touches++; });
  const selectedEndpoint = ref("napcat"), automationTemplateDialog = ref(true);
  const handlers = pageHandlers({ store, selectedAutomationEndpoint: ref("napcat"), selectedEndpoint,
    automationTemplateDialog, automationTemplateRequest: undefined, automationTemplateLoading: ref(false), automationTemplateError: ref(""),
    openAutomation: (id: string) => { opened = id; }, automationTemplatePatch,
    loadAutomationTemplate, personaService: { fetch: async () => { throw new Error("Default template already contains its body."); } }, userFacingError: String });
  const memory = DEFAULT_AUTOMATION_TEMPLATES.find(item => item.id.endsWith(".memory-skills"))!;
  await handlers.createAutomation(memory);
  const rules = gateway.value.automationRules!; assert.equal(rules.length, 2); assert.equal(rules[0].action.type, "deliver_agent");
  if (rules[0].action.type === "deliver_agent") assert.equal(rules[0].action.message, "User message");
  const created = rules.find(item => item.id === opened)!; assert.equal(created.trigger.type, "schedule"); assert.equal(created.name, memory.title); assert.equal(selectedEndpoint.value, "schedule"); assert.equal(automationTemplateDialog.value, false); assert.ok(touches >= 2);
  if (created.action.type === "deliver_agent") { assert.equal(created.action.message, memory.action.message); created.action.message = "User edited rule"; }
  assert.notEqual(memory.action.message, "User edited rule");
});

test("closing a pending custom-template body cannot add a rule after cancellation", async () => {
  let added = 0;
  const dependencies: Record<string, unknown> = { store: { addAutomation: () => { added++; return "new"; }, updateAutomation: () => {} },
    selectedAutomationEndpoint: ref("schedule"), selectedEndpoint: ref("schedule"), automationTemplateDialog: ref(true),
    automationTemplateLoading: ref(false), automationTemplateError: ref(""), openAutomation: () => {}, automationTemplatePatch,
    personaService: {}, userFacingError: String
  };
  let signal!: AbortSignal;
  dependencies.loadAutomationTemplate = async (_fetcher: unknown, input: AbortSignal) => { signal = input; await new Promise<void>(resolve => input.addEventListener("abort", () => resolve(), { once: true })); return DEFAULT_AUTOMATION_TEMPLATES[0]; };
  const controller = new AbortController();
  const handlers = pageHandlers({ ...dependencies, automationTemplateRequest: undefined, AbortController: function () { return controller; } });
  const pending = handlers.createAutomation({ id: "io.example.custom", version: "1.0.0", title: "Custom", description: "Custom", triggerType: "schedule" });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(signal, controller.signal); controller.abort(); await pending; assert.equal(added, 0);
});


test("a custom id ending in blank retains its own schedule, content and target", async () => {
  const gateway = ref({ id: "Example", gatewayPort: 0, agentRoleId: "Example", automationScheduleSchemaVersion: 1, automationRules: [] } as GatewayDefinition);
  const store = createRoleEditorActions(() => gateway.value, () => {}), selectedEndpoint = ref("napcat");
  const handlers = pageHandlers({ store, selectedAutomationEndpoint: ref("napcat"), selectedEndpoint,
    automationTemplateDialog: ref(true), automationTemplateLoading: ref(false), automationTemplateError: ref(""), automationTemplateRequest: undefined,
    openAutomation: () => {}, automationTemplatePatch, loadAutomationTemplate, personaService: {}, userFacingError: String });
  const custom = { ...DEFAULT_AUTOMATION_TEMPLATES[0], id: "io.example.blank", title: "Custom blank suffix", action: { type: "deliver_agent" as const, message: "Keep custom body", target: { kind: "recipient" as const, recipientId: "message_pool" as const } } };
  await handlers.createAutomation(custom);
  const created = gateway.value.automationRules![0]; assert.equal(created.name, custom.title); assert.equal(created.trigger.type, "schedule");
  if (created.action.type === "deliver_agent") { assert.equal(created.action.message, "Keep custom body"); assert.deepEqual(created.action.target, custom.action.target); }
});

test("a late custom body after changing the selected role or source cannot create a rule for the replacement owner", async () => {
  for (const changedOwner of ["another-role", "another-source-computer", "another-persona-reference"]) {
    const owner = ref("original-role-source"), dialog = ref(true); let release!: () => void, added = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const handlers = pageHandlers({ automationTemplateOwner: owner,
      store: { addAutomation: () => { added++; return "new"; }, updateAutomation: () => {} }, selectedAutomationEndpoint: ref("schedule"), selectedEndpoint: ref("schedule"),
      automationTemplateDialog: dialog, automationTemplateRequest: undefined, automationTemplateLoading: ref(false), automationTemplateError: ref(""),
      openAutomation: () => {}, automationTemplatePatch, personaService: {}, userFacingError: String,
      loadAutomationTemplate: async () => { await waiting; return DEFAULT_AUTOMATION_TEMPLATES[0]; } });
    const pending = handlers.createAutomation({ id: "io.example.pending", version: "1.0.0", title: "Pending", description: "Pending body", triggerType: "schedule" });
    owner.value = changedOwner; release(); await pending; assert.equal(added, 0);
  }
});


test("a malformed template target fails before creating a draft rule", async () => {
  const gateway = ref({ id: "Example", gatewayPort: 0, agentRoleId: "Example", automationScheduleSchemaVersion: 1, automationRules: [
    { id: "existing", name: "Original rule", trigger: { type: "message", routeKinds: ["private"] }, action: { type: "deliver_agent", message: "Keep original" } }
  ] } as GatewayDefinition);
  const before = JSON.parse(JSON.stringify(gateway.value.automationRules)), store = createRoleEditorActions(() => gateway.value, () => {}), error = ref("");
  const handlers = pageHandlers({ store, selectedAutomationEndpoint: ref("napcat"), selectedEndpoint: ref("napcat"),
    automationTemplateDialog: ref(true), automationTemplateLoading: ref(false), automationTemplateError: error, automationTemplateRequest: undefined,
    openAutomation: () => { throw new Error("Malformed template must not open a rule."); }, automationTemplatePatch, loadAutomationTemplate, personaService: {}, userFacingError: String });
  const custom = { ...DEFAULT_AUTOMATION_TEMPLATES[0], id: "io.example.invalid-target", action: { type: "deliver_agent", message: "Bad target", target: "bad-native-target" } };
  await handlers.createAutomation(custom);
  assert.deepEqual(gateway.value.automationRules, before); assert.match(error.value, /Invalid Agent delivery target/);
});

test("a failed template patch removes only its new rule and preserves the previous draft", async () => {
  const gateway = ref({ id: "Example", gatewayPort: 0, agentRoleId: "Example", automationScheduleSchemaVersion: 1, automationRules: [
    { id: "existing", name: "Original rule", trigger: { type: "message", routeKinds: ["private"] }, action: { type: "deliver_agent", message: "Keep original" } }
  ] } as GatewayDefinition);
  const actions = createRoleEditorActions(() => gateway.value, () => {}), error = ref("");
  actions.updateAutomation("existing", {});
  const before = structuredClone(toRaw(gateway.value.automationRules));
  const store = { ...actions, updateAutomation: (id: string, patch: Parameters<typeof actions.updateAutomation>[1]) => {
    actions.updateAutomation(id, patch); throw new Error("Controlled draft projection failure");
  } };
  const handlers = pageHandlers({ store, selectedAutomationEndpoint: ref("napcat"), selectedEndpoint: ref("napcat"),
    automationTemplateDialog: ref(true), automationTemplateLoading: ref(false), automationTemplateError: error, automationTemplateRequest: undefined,
    openAutomation: () => { throw new Error("Failed draft must not open."); }, automationTemplatePatch, loadAutomationTemplate, personaService: {}, userFacingError: String });
  await handlers.createAutomation(DEFAULT_AUTOMATION_TEMPLATES[0]);
  assert.deepEqual(gateway.value.automationRules, before); assert.match(error.value, /Controlled draft projection failure/);
});
