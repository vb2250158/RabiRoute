import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";

test("call history events and cursors use submitted filters until the next query", async t => {
  const component = new URL("../../src/plugins/io.rabiroute.manager.diagnostics/web/components/AgentCallHistoryTab.vue", import.meta.url);
  const require = createRequire(component), vue = require("vue");
  const mounted: Array<() => void> = [], unmount: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  const requests: URL[] = [];
  let timerId = 0;
  const source = fs.readFileSync(component, "utf8");
  assert.match(source, /@submit\.prevent="applyFilters"/);
  const code = transformSync(compileScript(parse(source).descriptor, { id: "call-history-filters" }).content,
    { loader: "ts", format: "cjs" }).code;
  const module = { exports: {} as any };
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, URLSearchParams, Date,
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (input: string) => {
      const url = new URL(input, "http://fixture"); requests.push(url);
      return { ok: true, json: async () => ({ code: 0, data: { items: [], nextCursor: "fixture-next",
        recording: { enabled: true, captureBodies: true, maxBodyBytes: 4096, pending: 0, lastError: null, dropped: 0, conflicts: 0 } } }) };
    },
    require: (name: string) => name === "vue" ? { ...vue,
      onMounted: (callback: () => void) => mounted.push(callback),
      onBeforeUnmount: (callback: () => void) => unmount.push(callback) } :
      name.endsWith("managerApi") ? { managerEventSource: () => ({ addEventListener() {}, close() {} }) } :
      name.endsWith("userFacingError") ? { userFacingError: String } : require(name)
  });
  const scope = vue.effectScope();
  const model = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };
  t.after(() => { for (const callback of unmount) callback(); scope.stop(); });
  for (const callback of mounted) callback();
  await flush();
  model.query.value = "draft query";
  model.source.value = "cli";
  model.changed();
  for (const [id, callback] of timers) { timers.delete(id); callback(); }
  await flush();
  assert.equal(requests.at(-1)!.searchParams.get("query"), null);
  assert.equal(requests.at(-1)!.searchParams.get("source"), null);
  model.move(1); await flush();
  assert.equal(requests.at(-1)!.searchParams.get("cursor"), "fixture-next");
  assert.equal(requests.at(-1)!.searchParams.get("query"), null);
  model.applyFilters(); await flush();
  assert.equal(requests.at(-1)!.searchParams.get("query"), "draft query");
  assert.equal(requests.at(-1)!.searchParams.get("source"), "cli");
  assert.equal(requests.at(-1)!.searchParams.get("cursor"), null);
  assert.equal(model.page.value, 0);
  model.query.value = "unsubmitted replacement";
  model.move(1); await flush();
  assert.equal(requests.at(-1)!.searchParams.get("query"), "draft query");
  model.move(-1); await flush();
  assert.equal(requests.at(-1)!.searchParams.get("query"), "draft query");
});
