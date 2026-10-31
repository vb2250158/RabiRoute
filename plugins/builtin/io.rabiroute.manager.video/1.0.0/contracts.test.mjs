import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createVideoContracts, commandFields, projectRules, settingsFields, validJobView, validateCommand } from "./contracts.mjs";
import { validateCommand as workflowValidateCommand } from "./workflow.mjs";
import { VideoProjects } from "./projects.mjs";
import { VideoModels } from "./models.mjs";
const catalog = JSON.parse(await fs.readFile(new URL("./catalog.json", import.meta.url), "utf8"));

test("native command consumers share the same validator and limits as executable contract field definitions", () => {
  assert.equal(workflowValidateCommand, validateCommand);
  const model = catalog.models.find(row => row.mode === "image");
  const input = { model: model.id, prompt: "  preserved  ", width: null, height: null, seed: null };
  const result = validateCommand(input, catalog);
  assert.equal(result.prompt, "preserved"); assert.equal(result.width, model.width); assert.equal(result.seed, 1);
  assert.throws(() => validateCommand({ ...input, prompt: "p".repeat(commandFields.prompt.maxLength + 1) }, catalog), /提示词/);
  assert.throws(() => validateCommand({ ...input, extra: true }, catalog), /不支持的参数/);
  assert.throws(() => validateCommand({ ...input, seed: "1" }, catalog), /种子/);
  assert.throws(() => validateCommand({ ...input, frames: null }, catalog), /图片模型/);
});

test("wire schemas defer original native rejection while normalized DTOs describe real result fields", () => {
  const definitions = createVideoContracts(catalog), ajv = new Ajv2020({ strict: true });
  for (const [name, schema] of Object.entries(definitions.requests)) {
    const validate = ajv.compile(schema);
    for (const value of [null, [], {}, "", 1, false, { unknownField: true }]) assert.equal(validate(value), true, name);
  }
  for (const schema of Object.values(definitions.responses)) ajv.compile(schema);
  const save = ajv.compile(definitions.responses["project.save"]);
  assert.equal(save({ revision: 1 }), true); assert.equal(save({ revision: "1" }), false);
  const settings = definitions.responses["models.settings-read"];
  assert.ok(settings.anyOf[0].properties.effectiveModelRoot);
  assert.equal(ajv.compile(settings)({ providerExtension: [1, null], revision: "remote-owned" }), true);
});

test("shared project rules preserve opaque content and original validation ordering", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-schema-project-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const owner = new VideoProjects({ stateRoot: root }), id = randomUUID();
  await owner.create({ id });
  const value = { version: projectRules.version, items: [{ id: "v", kind: projectRules.kinds[0], unknown: true }], drafts: [null], active: "v", unknown: { keep: true } };
  await owner.save(id, { revision: 0, value, title: false });
  assert.deepEqual((await owner.read(id)).value, value);
  await assert.rejects(owner.save(id, { revision: 0, value: null }), error => error.status === 409);
  await assert.rejects(owner.save(id, { revision: 1, value: { ...value, items: Array.from({ length: projectRules.maxItems + 1 }, () => value.items[0]) } }), error => error.status === 400);
});

test("shared model field set preserves original local CAS errors and nullable path normalization", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-schema-models-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const received = [];
  const owner = new VideoModels({ stateRoot: root, defaultModelRoot: "default", alive: () => false, stopInstaller: async () => {}, validateModelRoot(value) { received.push(value); return null; } }, { models: [] }, () => {});
  await owner.initialize();
  for (const value of [null, "", "   "]) {
    const directories = await owner.configure({ modelRoot: value, expectedRevision: owner.settings.revision, layout: settingsFields.layout.enum[1] });
    assert.equal(directories.layout, "flat"); assert.equal(directories.modelRoot, null);
  }
  assert.deepEqual(received, [null, "", "   "]);
  await assert.rejects(owner.configure({ modelRoot: null, expectedRevision: owner.settings.revision, future: true }), error => error.status === 409);
  await assert.rejects(owner.initializeModels({ expectedRevision: owner.settings.revision, future: true }), error => error.status === 409);
  await owner.close();
});


test("stored public job fields obey the same field definitions as response validation", () => {
  const validate = new Ajv2020({strict:true}).compile(createVideoContracts(catalog).responses["job.read"]);
  for (const value of [{progress:"bad"},{error:{}},{updatedAt:null},{width:257},{references:[]},{references:["bad"]},
    {seed:-1},{progress:null},{createdAt:""},{progress:12},{references:["11111111-1111-4111-8111-111111111111"]}]) {
    assert.equal(validJobView(value), validate(value), JSON.stringify(value));
  }
});
