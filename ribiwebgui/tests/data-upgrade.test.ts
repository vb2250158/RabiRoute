import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";
import { createDataUpgradeController, upgradeQuantity, type DataUpgradeView } from "../src/dataUpgradeClient";
import type { DataUpgradeStatus } from "../../src/shared/dataUpgradeContract";

const status = (revision = 1): DataUpgradeStatus => ({ revision, state: "available", items: [{ id: "layout", title: "布局", description: "旧布局 → 新布局", state: "pending", recordCount: 0 }] });
const view = (): DataUpgradeView => ({ status: null, open: false, pending: false, error: "", uncertain: false });
const operation = (operationId: string): DataUpgradeStatus => ({ ...status(), state: "running", operation: { operationId, state: "running", startedAt: "now", updatedAt: "now", completedItems: 0, totalItems: 1 } });
const awaiting = (): DataUpgradeStatus => ({ ...operation("accepted-original"), state: "awaiting-restart", restartRequired: true,
  items: status().items.map(item => ({ ...item, state: "awaiting-restart" })), operation: { ...operation("accepted-original").operation!, state: "awaiting-restart", requiresRestart: true } });

test("reopened awaiting receipt is shown and only an explicit click resumes its original operation", async () => {
  const state = view(); let writes = 0; let newIds = 0;
  const controller = createDataUpgradeController(state, { read: async () => awaiting(), start: async request => {
    writes++; assert.equal(request.operationId, "accepted-original"); assert.equal(request.expectedRevision, 1); return awaiting();
  } }, () => { newIds++; return "replacement"; });
  await controller.ready(); assert.equal(state.open, true); assert.equal(writes, 0);
  await controller.confirm(); assert.equal(writes, 1); assert.equal(newIds, 0);
  controller.close(); controller.event({ ...awaiting(), revision: 2 }); assert.equal(state.open, false); assert.equal(writes, 1);
});

test("lost resume response reconciles original receipt without an automatic second write", async () => {
  const state = view(); let reads = 0; let writes = 0;
  const controller = createDataUpgradeController(state, { read: async () => { reads++; return awaiting(); }, start: async request => {
    writes++; assert.equal(request.operationId, "accepted-original"); throw new Error("response lost");
  } }, () => { throw new Error("must preserve original ID"); });
  await controller.ready(); await controller.confirm(); assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(state.uncertain, false);
  assert.equal(state.status?.operation?.operationId, "accepted-original");
  await controller.confirm(); assert.equal(writes, 2); // A second explicit user action, never a transport retry.
});

test("ready reads once; empty/current stays quiet; overview is shown once for a revision", async () => {
  const state = view(); let reads = 0;
  const controller = createDataUpgradeController(state, { read: async () => { reads++; return { revision: 0, state: "current", items: [] }; }, start: async () => status() });
  await controller.ready(); await controller.ready(); assert.equal(reads, 1); assert.equal(state.open, false);
  controller.event(status()); assert.equal(state.open, true); controller.close(); controller.event(status()); assert.equal(state.open, false);
  controller.event(status(2)); assert.equal(state.open, true); controller.dispose();
});

test("initial stale read and post-disposal response cannot overwrite an SSE snapshot", async () => {
  const state = view(); let resolve!: (value: DataUpgradeStatus) => void;
  const controller = createDataUpgradeController(state, { read: () => new Promise(done => { resolve = done; }), start: async () => status() });
  const initial = controller.ready(); controller.event(status(3)); resolve(status()); await initial;
  assert.equal(state.status?.revision, 3);
  controller.dispose(); controller.event(status(4)); assert.equal(state.status?.revision, 3);
});

test("events before readiness stay quiet and a closed running operation stays closed across progress revisions", async () => {
  const state = view();
  const controller = createDataUpgradeController(state, { read: async () => status(), start: async () => status() });
  controller.event(status()); assert.equal(state.open, false);
  await controller.ready(); assert.equal(state.open, true);
  controller.event(operation("original")); controller.close();
  controller.event({ ...operation("original"), revision: 3 }); assert.equal(state.open, false);
  controller.dispose();
});

test("double confirmation is suppressed; accepted work persists after page disposal", async () => {
  const state = view(); let resolve!: (value: DataUpgradeStatus) => void; let writes = 0; let signal: AbortSignal | undefined;
  const controller = createDataUpgradeController(state, { read: async () => status(), start: async (request, requestSignal) => {
    writes++; signal = requestSignal; assert.deepEqual(request, { operationId: "original", expectedRevision: 1 });
    return new Promise(done => { resolve = done; });
  } }, () => "original");
  await controller.ready(); const pending = controller.confirm(); await controller.confirm(); assert.equal(writes, 1);
  controller.dispose(); assert.equal(signal?.aborted, true); resolve(operation("original")); await pending;
  assert.equal(state.status?.state, "available");
});

test("lost start response reconciles once against the same operation without repeating writes", async () => {
  const state = view(); let reads = 0; let writes = 0;
  const controller = createDataUpgradeController(state, { read: async () => ++reads === 1 ? status() : operation("original"), start: async () => { writes++; throw new Error("connection lost"); } }, () => "original");
  await controller.ready(); await controller.confirm(); assert.equal(reads, 2); assert.equal(writes, 1); assert.equal(state.uncertain, false); assert.equal(state.status?.operation?.operationId, "original");
});

test("unreconciled result blocks repeat writes and late SSE resolves the original request", async () => {
  const state = view(); let writes = 0;
  const controller = createDataUpgradeController(state, { read: async () => status(), start: async () => { writes++; throw new Error("lost"); } }, () => "original");
  await controller.ready(); await controller.confirm(); await controller.confirm(); assert.equal(writes, 1); assert.equal(state.uncertain, true);
  controller.event(operation("original")); assert.equal(state.uncertain, false); assert.equal(state.error, "");
});

test("compiled dialog renders known zero separately from unknown, restart consent and running progress", () => {
  const component = new URL("../src/components/DataUpgradeDialog.vue", import.meta.url);
  const require = createRequire(component); const vue = require("vue");
  const code = transformSync(compileScript(parse(fs.readFileSync(component, "utf8")).descriptor, { id: "upgrade", inlineTemplate: true }).content, { loader: "ts", format: "cjs" }).code;
  const module = { exports: {} as any };
  vm.runInNewContext(code, { module, exports: module.exports, require: (name: string) => name === "vue" ? { ...vue, resolveComponent: (name: string) => name } : name.includes("dataUpgradeClient") ? { upgradeQuantity } : { useI18n: () => ({ t: (s: string) => s, isEnglish: vue.ref(false) }) } });
  const state = vue.reactive(view()); state.status = { ...status(), restartRequired: true }; state.open = true;
  const render = module.exports.default.setup({ view: state }, { expose() {}, emit() {} });
  function text(node: any): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(text).join("");
    if (!node) return "";
    if (node.children && typeof node.children === "object" && !Array.isArray(node.children)) return Object.values(node.children).filter(x => typeof x === "function").map((fn: any) => text(fn())).join("");
    return text(node.children);
  }
  const rendered = text(render({}, []));
  assert.match(rendered, /确认升级并重启/); assert.match(rendered, /数据数量：0/); assert.match(rendered, /数据大小：未知/); assert.match(rendered, /稍后/);
  state.status = operation("original");
  const running = text(render({}, [])); assert.match(running, /升级中/); assert.doesNotMatch(running, /确认升级并重启/);
  state.status = awaiting();
  const resume = text(render({}, [])); assert.match(resume, /继续升级并重启/); assert.doesNotMatch(resume, /确认升级并重启/);
});
