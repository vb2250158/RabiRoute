import assert from "node:assert/strict";
import test from "node:test";
import { configuredInProcessRoots, resolveInProcessRoots } from "./pluginExecutionSettings.js";

test("plugin execution roots are unrestricted unless the user configures them", () => {
  assert.equal(configuredInProcessRoots({}), undefined);
  assert.equal(configuredInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: "" }), undefined);
  assert.deepEqual(configuredInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: "[]" }), []);
  assert.deepEqual(configuredInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: '["packages"]' }), ["packages"]);
});

test("invalid execution settings identify the setting and its removal path", () => {
  for (const value of ["not-json", "{}", '[""]', "[42]"]) {
    assert.throws(() => configuredInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: value }), /RABIROUTE_PLUGIN_IN_PROCESS_ROOTS.*Clear.*Manager startup setting/s);
  }
});

 test("invalid optional roots are skipped without leaking the raw value or changing valid restrictions", () => {
  const raw = "private-malformed-setting";
  const result = resolveInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: raw });
  assert.equal(result.roots, undefined);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0]?.field, "RABIROUTE_PLUGIN_IN_PROCESS_ROOTS");
  assert.match(result.diagnostics[0]?.message ?? "", /Manager startup setting/);
  assert.equal(JSON.stringify(result).includes(raw), false);
  assert.equal(resolveInProcessRoots({}).roots, undefined);
  assert.deepEqual(resolveInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: "[]" }).roots, []);
  assert.deepEqual(resolveInProcessRoots({ RABIROUTE_PLUGIN_IN_PROCESS_ROOTS: '["packages"]' }).roots, ["packages"]);
 });
