import fs from "node:fs";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { configureTimeouts, getTimeoutMs } from "../../src/shared/timeoutSettings";
import { loadTimeoutSettings, saveTimeoutSettings } from "../src/timeoutSettingsClient";
import { boundedRouteCatalogMutationFetch } from "../src/routeCatalogMutationLedger";

function response(overrides: Record<string, number>, etag = '"v1"') {
  return Response.json({ code: 0, data: { overrides, catalog: [] } }, { headers: { etag } });
}
test("save merges unrelated changes, sends CAS and publishes independently read configuration", async () => {
  const requests: RequestInit[] = [];
  const fetcher = (async (_input, init) => {
    requests.push(init || {});
    if (requests.length === 1) return response({ existing: 100, unrelated: 500 });
    if (requests.length === 2) { assert.equal(new Headers(init?.headers).get("if-match"), '"v1"'); assert.deepEqual(JSON.parse(String(init?.body)).overrides, { existing: 200, unrelated: 500 }); }
    return response({ existing: 200, unrelated: 500 }, '"v2"');
  }) as typeof fetch;
  try {
    const result = await saveTimeoutSettings({ existing: 100 }, { existing: 200 }, fetcher);
    assert.equal(result.etag, '"v2"'); assert.equal(requests.length, 3); assert.equal(getTimeoutMs("existing", 1), 200);
  } finally { configureTimeouts({}); }
});
test("deleting an override restores its default and concurrent writes fail without retry", async () => {
  const calls: RequestInit[] = [];
  const fetcher = (async (_input, init) => { calls.push(init || {}); if (calls.length === 1) return response({ removable: 100 }); if (calls.length === 2) assert.deepEqual(JSON.parse(String(init?.body)).overrides, {}); return response({}); }) as typeof fetch;
  await saveTimeoutSettings({ removable: 100 }, {}, fetcher);
  assert.equal(getTimeoutMs("removable", 77), 77);
  let count = 0;
  await assert.rejects(saveTimeoutSettings({}, { value: 50 }, (async () => { count++; return count === 1 ? response({}) : Response.json({ code: 1 }, { status: 412 }); }) as typeof fetch), /草稿已保留/);
  assert.equal(count, 2);
});
test("invalid input and changed same-key values never issue a PATCH", async () => {
  let count = 0;
  const fetcher = (async () => { count++; return response({ value: 300 }); }) as typeof fetch;
  await assert.rejects(saveTimeoutSettings({}, { value: NaN }, fetcher), /整数/); assert.equal(count, 0);
  await assert.rejects(saveTimeoutSettings({ value: 100 }, { value: 200 }, fetcher), /其他页面/); assert.equal(count, 1);
});
test("settings deadline includes response body and route mutations retain caller cancellation", async () => {
  const server = createServer((_request, reply) => { reply.writeHead(200, { "content-type": "application/json" }); reply.flushHeaders(); reply.write('{"code":'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const fetcher = ((_input: unknown, init?: RequestInit) => fetch("http://127.0.0.1:" + address.port, init)) as typeof fetch;
  configureTimeouts({ "webgui.timeouts.request": 100 });
  try {
    await assert.rejects(loadTimeoutSettings(fetcher), /abort|timeout/i);
    const controller = new AbortController(); controller.abort(new Error("caller canceled"));
    await assert.rejects(boundedRouteCatalogMutationFetch("/example", { signal: controller.signal }, { fetchImpl: fetcher }), /caller canceled/);
    configureTimeouts({ "webgui.gateway.mutation": 100 });
    const reply = await boundedRouteCatalogMutationFetch("/example", {}, { fetchImpl: fetcher });
    await assert.rejects(reply.json(), /abort|timeout/i);
  } finally { configureTimeouts({}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("settings component retains invalid and conflicting drafts and supports restoring defaults", async () => {
  let copied = "";
  const source = fs.readFileSync(new URL("../src/components/TimeoutSettings.vue", import.meta.url), "utf8");
  const script = compileScript(parse(source).descriptor, { id: "timeout-settings-test" });
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const output = { exports: {} as any };
  vm.runInNewContext(compiled.outputText, { module: output, exports: output.exports,
    require(name: string) {
      if (name === "vue") return { ...vue, onMounted() {} };
      if (name === "../clipboard") return { copyTextToClipboard: async (text: string) => { copied = text; } };
      if (name === "../timeoutSettingsClient") return {
        loadTimeoutSettings: async () => ({ overrides: { request: 500 }, catalog: [{ key: "request", defaultMs: 100, label: "Request", scope: "webgui", effect: "new-request" }] }),
        saveTimeoutSettings: async () => { throw new Error("conflict"); }
      };
      throw new Error("Unexpected import: " + name);
    }, console, Error });
  const component = output.exports.default.setup({}, { expose() {} });
  await component.load();
  component.change("request", 0); assert.equal(component.valid.value, false);
  component.change("request", ""); assert.equal(component.draft.value.request, undefined); assert.equal(component.dirty.value, true);
  component.change("request", 700); await component.save();
  assert.equal(component.draft.value.request, 700); assert.equal(component.error.value, "conflict");
  component.settings.value.credentials = "fixture-secret";
  component.settings.value.overrides.invalid = "fixture-secret";
  await component.exportSettings();
  assert.deepEqual(JSON.parse(copied), { request: 500 });
  assert.equal(copied.includes("fixture-secret"), false);
  assert.equal(copied.includes("700"), false);
  component.settings.value.catalog = Array.from({ length: 85 }, (_, index) => ({ key: "item." + index, defaultMs: 100, label: "Item " + index, scope: "fixture", effect: "new-request" }));
  await vue.nextTick();
  assert.equal(component.pageEntries.value.length, 40);
  assert.equal(component.pageCount.value, 3);
  component.change("item.0", 101);
  component.page.value = 3;
  assert.equal(component.pageEntries.value.length, 5);
  assert.equal(component.pageEntries.value[0].key, "item.80");
  component.change("item.84", 184);
  component.search.value = "Item 84";
  await vue.nextTick();
  assert.equal(component.page.value, 1);
  assert.equal(component.pageEntries.value.length, 1);
  assert.equal(component.pageEntries.value[0].key, "item.84");
  component.search.value = "";
  await vue.nextTick();
  assert.equal(component.pageEntries.value.length, 40);
  assert.equal(component.draft.value["item.0"], 101);
  assert.equal(component.draft.value["item.84"], 184);
  assert.equal(component.draft.value.request, 700);
});
