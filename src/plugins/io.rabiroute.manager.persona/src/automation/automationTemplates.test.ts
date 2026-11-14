import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AUTOMATION_TEMPLATES, automationTemplateCatalog, automationTemplatePatch } from "./automationTemplates.js";

test("default templates include the full memory-to-Skill workflow and expand to editable ordinary rule fields", () => {
  assert.equal(DEFAULT_AUTOMATION_TEMPLATES.length, 6);
  const memory = DEFAULT_AUTOMATION_TEMPLATES.find(item => item.id.endsWith(".memory-skills"))!;
  assert.equal(memory.triggerType, "schedule"); assert.match(memory.action.message, /已有 Skill/); assert.match(memory.action.message, /创建 Skill/); assert.match(memory.action.message, /回读/);
  const patch = automationTemplatePatch(memory); assert.equal(patch.action?.type, "deliver_agent");
  if (patch.action?.type === "deliver_agent") { patch.action.message = "User edited"; }
  assert.notEqual(memory.action.message, "User edited"); assert.equal(patch.name, memory.title);
});

test("plugin templates extend the same catalog and one bad item does not remove valid templates", () => {
  const custom = { id: "io.example.plugin.review", version: "1.0.0", title: "Custom", description: "Plugin task", triggerType: "schedule", action: { type: "deliver_agent", message: "Custom instructions" } };
  const result = automationTemplateCatalog([null, custom, custom]);
  assert.equal(result.items.length, 7); assert.equal(result.warnings.length, 1); assert.equal(result.items.at(-1)?.id, custom.id);
  assert.equal(result.items.filter(item => item.id === custom.id).length, 1);
});


test("plugin template shorthand follows the shared discovery metadata and preserves explicit targets", () => {
  const catalog = automationTemplateCatalog([{ id: "io.example.shorthand", version: "1.0.0", title: "Shorthand", message: "Work" },
    { id: "io.example.target", version: "1.0.0", title: "Target", description: "Explicit target", action: { type: "deliver_agent", message: "Work", target: { kind: "recipient", recipientId: "message_pool" } } }]);
  assert.equal(catalog.warnings.length, 0); assert.equal(catalog.items.length, 8);
  assert.equal(catalog.items.at(-2)?.triggerType, undefined); assert.equal(catalog.items.at(-2)?.action.message, "Work");
  const patch = automationTemplatePatch(catalog.items.at(-1)!);
  if (patch.action?.type === "deliver_agent") assert.deepEqual(patch.action.target, { kind: "recipient", recipientId: "message_pool" });
});
