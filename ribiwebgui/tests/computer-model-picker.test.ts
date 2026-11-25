import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";

test("model picker reads the candidate machine, discards a late catalog and commits only a model click", async t => {
  const url = new URL("../src/components/ComputerModelPicker.vue", import.meta.url);
  const require = createRequire(url);
  const vue = require("vue");
  const component = compileScript(parse(fs.readFileSync(url, "utf8")).descriptor, { id: "model-picker-test" });
  const code = transformSync(component.content, { loader: "ts", format: "cjs" }).code;
  const mod = { exports: {} as { default?: { setup: Function } } };
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, AbortController,
    require: (name: string) => {
      if (name === "vue") return { ...vue, useModel: () => vue.ref(true), onBeforeUnmount() {} };
      if (name.endsWith("readPreviewCache")) return {
        readPreview: (key: string[]) => key.at(-1) === "second" ? [{ value: "preview", title: "Cached model" }] : undefined,
        writePreview() {}, previewAccessDenied: () => false
      };
      if (name.endsWith("i18n/index")) return { useI18n: () => ({ t: (value: string) => value }) };
      return { userFacingError: (error: Error) => error.message };
    }
  });
  const pending = new Map<string, { signal: AbortSignal; resolve: (value: { title: string; value: string }[]) => void }>();
  const commits: string[][] = [];
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const picker = scope.run(() => mod.exports.default!.setup({
    deviceId: "saved-machine",
    computers: { options: [], menuChanged() {} },
    loadModels: (id: string, signal: AbortSignal) => new Promise(resolve => pending.set(id, { signal, resolve })),
    choose: (device: string, model: string) => { commits.push([device, model]); return commits.length > 1; }
  }, { expose() {} }));
  const first = picker.showModels({ value: "first", title: "First PC" });
  await new Promise(resolve => setImmediate(resolve));
  const second = picker.showModels({ value: "second", title: "Second PC" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.get("first")!.signal.aborted, true);
  assert.equal(picker.options.value[0].value, "preview");
  await picker.chooseModel(picker.options.value[0]);
  assert.deepEqual(commits, []);
  const option = { value: "model-b", title: "Model B" };
  pending.get("second")!.resolve([option]);
  await second;
  pending.get("first")!.resolve([{ value: "model-a", title: "Model A" }]);
  await first;
  assert.deepEqual(picker.options.value.map((row: { value: string }) => row.value), ["model-b"]);
  assert.deepEqual(commits, []);

  await picker.chooseModel(option);
  assert.equal(picker.open.value, true);
  await picker.chooseModel(option);
  assert.deepEqual(commits, [["second", "model-b"], ["second", "model-b"]]);
  assert.equal(picker.open.value, false);
});
