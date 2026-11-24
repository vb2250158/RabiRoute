import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { computed, ref, watch } from "vue";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import { DEFAULT_AUTOMATION_TEMPLATES, loadAutomationTemplate, loadAutomationTemplates } from "./automationTemplateClient";
import { applyAutomationPatch, createRoleEditorActions, newAutomationDraft } from "./roleEditorActions";
import { automationEndpoint } from "./automationEndpoints";
import { normalizeAgentDeliveryTarget } from "../../../../shared/agentDeliveryTarget";
import type { RoleConfiguration } from "../../../../shared/roleConfiguration";
import type { GatewayDefinition, PersonaAutomationRuleDefinition } from "../../../../../ribiwebgui/src/types";

const names = [
  "openAutomationCreation", "beginAutomationPreview", "previewFromTemplate", "confirmAutomation",
  "automationTemplateChoice", "templateDeliveryAction", "patchAutomation", "withAutomationTemplateRequest", "selectAutomationAction",
  "saveCustomAutomationTemplate", "removeCustomAutomationTemplate"
];
const filename = new URL("../pages/PersonaTemplatePage.vue", import.meta.url);
const parsed = parse(fs.readFileSync(filename, "utf8"));
assert.deepEqual(parsed.errors, []);
const script = compileScript(parsed.descriptor, { id: "automation-template-test" });
const template = compileTemplate({ source: parsed.descriptor.template!.content, filename: filename.pathname,
  id: "automation-template-test", compilerOptions: { bindingMetadata: script.bindings } });
assert.deepEqual(template.errors, []);
const ast = ts.createSourceFile("page.ts", script.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functions: string[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) functions.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(functions.length, names.length);
const handlers = ts.transpileModule(functions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function editor(options: Record<string, unknown> = {}) {
  const draft = ref<GatewayDefinition & RoleConfiguration>({
    id: "Example", gatewayPort: 0, agentRoleId: "Example", automationScheduleSchemaVersion: 1,
    automationRules: [{ id: "existing", name: "Keep existing", trigger: { type: "message", routeKinds: ["private"] },
      action: { type: "deliver_agent", message: "Original", target: { kind: "recipient", recipientId: "message_pool" } } }]
  });
  const actions = createRoleEditorActions(() => draft.value, () => {});
  const activeId = ref("existing");
  const automationPreview = ref<PersonaAutomationRuleDefinition | null>(null);
  const automationEdit = ref<PersonaAutomationRuleDefinition | null>(JSON.parse(JSON.stringify(draft.value.automationRules![0])));
  const automationDialog = ref(false);
  const automationCreationDialog = ref(false);
  const creationTemplateId = ref<string | null>(null);
  watch(automationDialog, open => { if (!open) { automationPreview.value = null; automationEdit.value = null; } }, { flush: "sync" });
  const activeAutomation = computed(() => automationPreview.value ?? automationEdit.value);
  const ownAutomationTemplates = computed(() => draft.value.automationDeliveryTemplates ?? []);
  const selectedAutomationTemplateId = ref("");
  const selectedCustomAutomationTemplate = computed(() => ownAutomationTemplates.value
    .find(item => selectedAutomationTemplateId.value === "custom:" + item.id));
  const automationTemplateError = ref("");
  const automationTemplates = ref([...DEFAULT_AUTOMATION_TEMPLATES]);
  let saves = 0;
  const bindings = {
    store: { ...actions, ready: true, saving: false, submitConfig() { saves++; }, get draft() { return draft.value; } }, ownAutomationTemplates, selectedCustomAutomationTemplate,
    automations: computed(() => draft.value.automationRules ?? []), automationDraftIncomplete: ref(false),
    gateway: draft, automationPreview, automationEdit, automationDialog, automationCreationDialog, creationTemplateId,
    automationCreationEndpoint: ref("napcat"), choosingCreationTemplate: ref(false), automationPreviewIncomplete: ref(false),
    newAutomationDraft, applyAutomationPatch, automationEndpoint,
    activeAutomation, selectedAutomationTemplateId, automationTemplateError, automationTemplates,
    automationTemplateLoading: ref(false), automationTemplateName: ref("My custom template"),
    automationTemplateRequest: undefined, editingAutomationTemplateName: ref(false), normalizeAgentDeliveryTarget,
    browserUuid: () => "test-id", selectedAutomationEndpoint: ref("napcat"), personaService: {}, userFacingError: String,
    loadAutomationTemplate, openAutomation(id: string) {
      activeId.value = id;
      if (!automationPreview.value) automationEdit.value = JSON.parse(JSON.stringify(draft.value.automationRules!.find(rule => rule.id === id)));
      automationDialog.value = true;
    },
    setAutomationActionType() {},
    selectedEndpoint: { set value(endpoint: string) {
      if (endpoint === "schedule" && activeAutomation.value?.trigger.type !== "schedule") {
        const patch = { trigger: { type: "schedule" as const, schedule: { id: "sample-time", type: "interval" as const, intervalSeconds: 900 } } };
        if (automationPreview.value) automationPreview.value = applyAutomationPatch(automationPreview.value, patch);
        else actions.updateAutomation(activeId.value, patch);
      }
    } },
    ...options
  };
  const run = new Function(...Object.keys(bindings), handlers + ";return {" + names.join(",") + "};")(...Object.values(bindings));
  return { ...run, openAutomation: bindings.openAutomation, activeAutomation, activeId, draft, actions, automationDialog, automationCreationDialog, creationTemplateId,
    automationTemplateError, selectedAutomationTemplateId, saves: () => saves };
}

test("template client reads small pages and fetches a selected plugin body from the supplied source", async () => {
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

test("manual and template previews leave existing rules unchanged until Create is confirmed", async () => {
  const ui = editor();
  const initial = JSON.stringify(ui.draft.value.automationRules);
  ui.openAutomationCreation();
  assert.equal(ui.automationCreationDialog.value, true);
  ui.beginAutomationPreview();
  ui.patchAutomation({ name: "Unconfirmed edits" });
  ui.automationDialog.value = false;
  assert.equal(JSON.stringify(ui.draft.value.automationRules), initial);

  const preset = DEFAULT_AUTOMATION_TEMPLATES[0];
  ui.openAutomationCreation();
  ui.creationTemplateId.value = "catalog:" + preset.id;
  await ui.previewFromTemplate();
  assert.equal(ui.automationDialog.value, true);
  assert.equal(JSON.stringify(ui.draft.value.automationRules), initial);
  assert.equal(ui.activeAutomation.value!.trigger.type, "schedule");
  assert.equal(ui.activeAutomation.value!.action.message, preset.action.message);
  ui.patchAutomation({ name: "Tweaked preset" });
  ui.confirmAutomation();
  ui.confirmAutomation();
  assert.equal(ui.saves(), 1);
  assert.equal(ui.draft.value.automationRules!.length, 2);
  assert.equal(ui.draft.value.automationRules![1].name, "Tweaked preset");
  assert.equal(ui.draft.value.automationRules![0].action.message, "Original");
});

test("custom template save, reuse, update and delete preserve independent rule text and targets", async () => {
  const ui = editor();
  ui.saveCustomAutomationTemplate();
  const templates = () => ui.draft.value.automationDeliveryTemplates!;
  assert.deepEqual(templates()[0], { id: "test-id", title: "My custom template", triggerType: "message", message: "Original", template: "" });

  ui.openAutomationCreation();
  ui.beginAutomationPreview();
  const createdId = ui.activeAutomation.value!.id;
  ui.confirmAutomation();
  ui.openAutomation(createdId);
  await ui.selectAutomationAction("custom:test-id");
  assert.equal(ui.activeAutomation.value!.action.message, "Original");
  assert.deepEqual(ui.activeAutomation.value!.action.target, { kind: "recipient", recipientId: "primary" });
  ui.patchAutomation({ action: { ...ui.activeAutomation.value!.action, message: "New text" } });
  ui.saveCustomAutomationTemplate();
  assert.equal(templates()[0].message, "New text");
  assert.equal(ui.draft.value.automationRules![0].action.message, "Original");
  ui.removeCustomAutomationTemplate();
  assert.deepEqual(templates(), []);
  assert.equal(ui.activeAutomation.value!.action.message, "New text");
});

test("a late plugin body cannot overwrite a changed draft or a replacement rule", async () => {
  for (const change of ["draft", "rule"]) {
    const { action, ...summary } = DEFAULT_AUTOMATION_TEMPLATES[0];
    const preset = { ...summary, id: "io.example.blank" };
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const ui = editor({ automationTemplates: ref([preset]), loadAutomationTemplate: async () => {
      await waiting;
      return { ...preset, action };
    } });
    const pending = ui.selectAutomationAction("catalog:" + preset.id);
    if (change === "rule") {
      ui.openAutomationCreation();
      ui.beginAutomationPreview();
    }
    else ui.patchAutomation({ action: { ...ui.activeAutomation.value!.action, message: "Edited" } });
    finish();
    await pending;
    assert.equal(ui.activeAutomation.value!.trigger.type, "message");
    assert.equal(ui.activeAutomation.value!.action.message, change === "rule" ? "" : "Edited");
    assert.equal(ui.selectedAutomationTemplateId.value, "");
  }
});

test("malformed plugin targets leave the draft and trigger intact", async () => {
  const preset = { ...DEFAULT_AUTOMATION_TEMPLATES[0], id: "io.example.invalid-target",
    action: { type: "deliver_agent", message: "Bad target", target: "bad-native-target" } };
  const ui = editor({ automationTemplates: ref([preset]) });
  const before = JSON.stringify(ui.draft.value.automationRules);
  await ui.selectAutomationAction("catalog:" + preset.id);
  assert.equal(JSON.stringify(ui.draft.value.automationRules), before);
  assert.match(ui.automationTemplateError.value, /Invalid Agent delivery target/);
});
