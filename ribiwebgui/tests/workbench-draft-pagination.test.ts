import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";

const pages = new URL("../../src/plugins/io.rabiroute.manager.video/web/pages/", import.meta.url);
function fixture(t: TestContext, name = "WorkbenchPanel", props: Record<string, unknown> = { projectId: "project" }) {
  const file = new URL(`${name}.vue`, pages);
  const require = createRequire(file), vue = require("vue");
  const descriptor = parse(fs.readFileSync(file, "utf8")).descriptor;
  const script = compileScript(descriptor, { id: name });
  const template = compileTemplate({ source: descriptor.template!.content, filename: file.pathname, id: name, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const requests: { url: URL; method: string; body: any }[] = [];
  const blobs: Blob[] = [], cleanup: (() => void)[] = [];
  let respond: (url: URL, method: string, body: any) => any = () => ({});
  let uuid = 0;
  const canvas = { positions: vue.ref({}), viewport: vue.ref(), transform: vue.ref({}), grid: vue.ref({}), fit() {}, add(id: string) { canvas.positions.value[id] = { x: 10, y: 20 }; } };
  const module = { exports: {} as any };
  class BrowserURL extends URL {
    static createObjectURL(blob: Blob) { blobs.push(blob); return "blob:fixture"; }
    static revokeObjectURL() {}
  }
  vm.runInNewContext(transformSync(script.content, { loader: "ts", format: "cjs" }).code, {
    module, exports: module.exports, structuredClone, URL: BrowserURL, URLSearchParams, Blob,
    location: { href: "http://fixture/?canvas=canvas" }, history: { replaceState() {} },
    window: { history: { replaceState() {} } },
    document: { createElement: () => ({ click() {} }) },
    sessionStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    fetch: async (input: string, options: any) => {
      const url = new URL(input, "http://fixture"), method = options?.method || "GET", body = options?.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, method, body });
      const result = await respond(url, method, body);
      return { ok: true, json: async () => result };
    },
    require: (dependency: string) => {
      if (dependency === "vue") return { ...vue, onMounted() {}, onBeforeUnmount: (fn: () => void) => cleanup.push(fn) };
      if (dependency.endsWith("browserUuid")) return { browserUuid: () => `new-${++uuid}` };
      if (dependency === "./useVideoCanvas") return { useVideoCanvas: () => canvas };
      if (dependency.endsWith("managerApi")) return { managerEventSource: () => ({ addEventListener() {}, close() {} }) };
      if (dependency.endsWith(".vue")) return { default: {} };
      return require(dependency);
    }
  });
  const scope = vue.effectScope();
  const model = scope.run(() => module.exports.default.setup(props, { expose() {}, emit() {} }));
  t.after(() => { cleanup.forEach(fn => fn()); scope.stop(); });
  return { model, canvas, requests, blobs, descriptor, respond(fn: typeof respond) { respond = fn; } };
}
function canvasRecord() {
  return { version: 2, id: "canvas", name: "Canvas", revision: 3, workspaceBindingKey: "workspace", variables: [], graph: { nodes: [
    { id: "first", kind: "command", config: { argv: ["old"] }, layout: { x: 0, y: 0 } },
    { id: "second", kind: "command", config: { argv: ["second"] }, layout: { x: 400, y: 0 } }
  ], edges: [], groups: [] } };
}
function edit(f: ReturnType<typeof fixture>, argv = "edited") {
  f.model.editor.value = JSON.stringify({ config: { argv: [argv] }, inputs: [], requirements: [] });
}

test("parameter input marks dirty and saving includes unapplied parameters, variables and positions", async t => {
  const f = fixture(t), m = f.model;
  m.value.value = canvasRecord(); m.select(m.value.value.graph.nodes[0]); edit(f);
  assert.match(f.descriptor.template!.content, /v-model="editor"[^>]*@input="dirty=true"/);
  m.dirty.value = true;
  m.variables.value = '[{"name":"topic","type":"string","value":"new"}]';
  f.canvas.positions.value = { first: { x: 44, y: 55 } };
  f.respond((_url, _method, body) => ({ ...body, revision: 4 }));
  await m.action(m.save);
  const sent = f.requests[0].body;
  assert.deepEqual(sent.graph.nodes[0].config.argv, ["edited"]);
  assert.equal(sent.variables[0].value, "new");
  assert.deepEqual(sent.graph.nodes[0].layout, { x: 44, y: 55 });
  assert.equal(m.dirty.value, false);
});

test("selecting and adding nodes apply valid drafts and retain invalid drafts with an error", async t => {
  const f = fixture(t), m = f.model;
  m.value.value = canvasRecord(); m.select(m.value.value.graph.nodes[0]); edit(f);
  await m.action(async () => m.select(m.value.value.graph.nodes[1]));
  assert.equal(m.value.value.graph.nodes[0].config.argv[0], "edited");
  edit(f, "before-add"); await m.action(async () => m.add("command"));
  assert.equal(m.value.value.graph.nodes[1].config.argv[0], "before-add");
  const selected = m.selected.value, count = m.value.value.graph.nodes.length;
  m.editor.value = "{broken";
  await m.action(async () => m.select(m.value.value.graph.nodes[0]));
  assert.equal(m.selected.value, selected); assert.equal(m.editor.value, "{broken"); assert.ok(m.error.value);
  await m.action(async () => m.add("command"));
  assert.equal(m.value.value.graph.nodes.length, count);
  m.editor.value = "null";
  await m.action(async () => m.select(m.value.value.graph.nodes[0]));
  assert.equal(m.selected.value, selected); assert.equal(m.editor.value, "null"); assert.match(m.error.value, /config/);
});

test("export includes current parameters, variables and dragged layout and reports invalid JSON", async t => {
  const f = fixture(t), m = f.model;
  m.value.value = canvasRecord(); m.select(m.value.value.graph.nodes[0]); edit(f);
  m.variables.value = '[{"name":"current","type":"string","value":"value"}]'; f.canvas.positions.value = { first: { x: 90, y: 80 } };
  await m.action(m.exportDraft);
  const draft = JSON.parse(await f.blobs[0].text());
  assert.deepEqual(draft.graph.nodes[0].config.argv, ["edited"]);
  assert.equal(draft.variables[0].name, "current"); assert.deepEqual(draft.graph.nodes[0].layout, { x: 90, y: 80 });
  m.editor.value = "{broken"; await m.action(m.exportDraft);
  assert.equal(f.blobs.length, 1); assert.equal(m.editor.value, "{broken"); assert.ok(m.error.value);
  edit(f); m.variables.value = "[broken"; await m.action(m.exportDraft);
  assert.equal(f.blobs.length, 1); assert.equal(m.variables.value, "[broken"); assert.ok(m.error.value);
});

test("invalid drafts and failed saves preserve local work and block canvas switching", async t => {
  const f = fixture(t), m = f.model;
  m.value.value = canvasRecord(); m.select(m.value.value.graph.nodes[0]); edit(f); m.dirty.value = true;
  m.editor.value = "{broken"; await m.action(m.save);
  assert.equal(f.requests.length, 0); assert.equal(m.editor.value, "{broken"); assert.equal(m.dirty.value, true);
  edit(f); f.respond(() => { throw new Error("save failed"); });
  await m.action(m.save);
  assert.match(m.error.value, /save failed/); assert.equal(m.value.value.revision, 3); assert.equal(m.dirty.value, true);
  assert.equal(m.editor.value.includes("edited"), true);
  await m.action(() => m.open("other"));
  assert.equal(f.requests.length, 1); assert.equal(m.value.value.id, "canvas"); assert.ok(m.error.value);
});

test("save completion preserves newer edits and Run waits for the complete saved draft", async t => {
  const f = fixture(t), m = f.model;
  m.value.value = canvasRecord(); m.select(m.value.value.graph.nodes[0]); edit(f); m.dirty.value = true;
  let release!: (value: unknown) => void;
  f.respond(() => new Promise(resolve => { release = resolve; }));
  const saving = m.action(m.save);
  await Promise.resolve();
  assert.equal(m.busy.value, true);
  assert.match(f.descriptor.template!.content, /:dirty="dirty\|\|busy"/);
  edit(f, "newer"); m.value.value.name = "Newer name";
  release({ ...f.requests[0].body, revision: 4 }); await saving;
  assert.equal(m.dirty.value, true); assert.equal(m.editor.value.includes("newer"), true);
  assert.equal(m.value.value.name, "Newer name"); assert.equal(m.value.value.revision, 4);
  const run = fixture(t, "WorkbenchRunPanel", { projectId: "project", canvasId: "canvas", revision: 4, dirty: true });
  await run.model.action(() => run.model.start());
  assert.equal(run.requests.length, 0); assert.match(run.model.error.value, /保存/);
});

test("canvas and run-history pagination append unique rows and replace on a new search", async t => {
  const f = fixture(t), m = f.model;
  f.respond(url => url.searchParams.has("cursor") ? { canvases: [{ id: "one", name: "updated" }, { id: "two" }], nextCursor: null } : { canvases: [{ id: "zero" }, { id: "one" }], nextCursor: "next" });
  await m.list(); await m.list(true);
  assert.deepEqual(Array.from(m.rows.value, (row: any) => row.id), ["zero", "one", "two"]);
  m.search.value = "new"; await m.list();
  assert.equal(m.rows.value.length, 2); assert.equal(f.requests.at(-1)!.url.searchParams.get("cursor"), null);
  f.respond(() => { throw new Error("list unavailable"); });
  await m.action(() => m.list()); assert.equal(m.rows.value.length, 2); assert.match(m.error.value, /list unavailable/);
  const r = fixture(t, "WorkbenchRunPanel", { projectId: "project", canvasId: "canvas", revision: 3, dirty: false });
  r.respond(url => url.searchParams.has("cursor") ? { runs: [{ id: "one" }, { id: "two" }], nextCursor: null } : { runs: [{ id: "zero" }, { id: "one" }], nextCursor: "next" });
  await r.model.loadHistory(); await r.model.loadHistory(true);
  assert.deepEqual(Array.from(r.model.history.value, (row: any) => row.id), ["zero", "one", "two"]);
  await r.model.loadHistory(); assert.equal(r.model.history.value.length, 2);
});

test("logs continue from the original cursor, stay bounded and can restart for another run", async t => {
  const f = fixture(t, "WorkbenchRunPanel", { projectId: "project", canvasId: "canvas", revision: 3, dirty: false }), m = f.model;
  f.respond(url => {
    if (!url.pathname.endsWith("/logs")) return { id: url.pathname.split("/").at(-1), projectId: "project", canvasId: "canvas", state: "completed", attempts: {} };
    const after = Number(url.searchParams.get("after"));
    const count = url.pathname.includes("other") || after >= 600 ? 1 : 100;
    return { entries: Array.from({ length: count }, (_, index) => ({ sequence: after + index + 1, stream: "stdout", text: "line" })), nextCursor: after + count };
  });
  await m.openRun("original");
  assert.equal(m.entries.value.length, 100);
  assert.match(f.descriptor.template!.content, /继续读取日志/);
  for (let page = 0; page < 5; page++) await m.action(m.refresh);
  assert.equal(m.entries.value.length, 500); assert.equal(m.entries.value[0].sequence, 101);
  assert.equal(f.requests.at(-1)!.url.searchParams.get("after"), "500");
  assert.equal(m.logsAtEnd.value, false);
  await m.action(m.refresh); assert.equal(m.logsAtEnd.value, true);
  assert.equal(m.entries.value.at(-1).sequence, 601);
  await m.action(m.restartLogs);
  assert.equal(m.entries.value[0].sequence, 1); assert.equal(f.requests.at(-1)!.url.searchParams.get("after"), "0");
  await m.openRun("other");
  assert.equal(m.entries.value.length, 1); assert.equal(m.entries.value[0].sequence, 1);
  assert.equal(m.logsAtEnd.value, true);
  await m.start();
  assert.equal(m.entries.value[0].sequence, 1); assert.equal(m.logsAtEnd.value, false);
});

test("a newly accepted run clears old log state when the previous log read fails", async t => {
  const f = fixture(t, "WorkbenchRunPanel", { projectId: "project", canvasId: "canvas", revision: 3, dirty: false }), m = f.model;
  const record = (id: string) => ({ id, projectId: "project", canvasId: "canvas", state: "running", attempts: {} });
  let rejectOld!: (error: Error) => void;
  f.respond((url, method) => {
    if (method === "POST") return record("new-run");
    if (url.pathname.endsWith("/old-run/logs")) return new Promise((_resolve, reject) => { rejectOld = reject; });
    if (url.pathname.endsWith("/logs")) return { entries: [{ sequence: 1, stream: "stdout", text: "new" }], nextCursor: 1 };
    return record(url.pathname.split("/").at(-1)!);
  });
  m.run.value = record("old-run"); m.entries.value = [{ sequence: 80, stream: "stdout", text: "old" }]; m.logsAtEnd.value = true;
  const oldRead = m.refresh().catch(() => undefined);
  await new Promise(resolve => setImmediate(resolve));
  const starting = m.action(() => m.start());
  await new Promise(resolve => setImmediate(resolve));
  rejectOld(new Error("old log unavailable")); await oldRead; await starting;
  assert.equal(m.run.value.id, "new-run"); assert.equal(m.entries.value.length, 0); assert.equal(m.logsAtEnd.value, false);
  await m.action(m.refresh);
  assert.equal(f.requests.at(-1)!.url.searchParams.get("after"), "0"); assert.equal(m.entries.value[0].text, "new");
});
