import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";

function host(revision = 0) {
  const source = fs.readFileSync(new URL("./MessageEndpointCardHost.vue", import.meta.url), "utf8");
  const script = compileScript(parse(source).descriptor, { id: "endpoint-card-host-test" });
  const compiled = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} as any };
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports,
    require(name: string) {
      if (name === "vue") return { ...vue, onErrorCaptured() {} };
      if (name === "../userFacingError") return { userFacingError: (cause: Error) => cause.message };
      throw new Error(`Unexpected endpoint host import: ${name}`);
    }
  });
  const props = vue.reactive({ renderers: [], context: { routeId: "original", messageEndpointType: "test" }, active: false, enabled: true, lifecycleRevision: revision });
  const scope = vue.effectScope();
  const emitted: boolean[] = [];
  const model = scope.run(() => module.exports.default.setup(props, { expose() {}, emit(_name: string, value: boolean) { emitted.push(value); } }));
  return { props, model, emitted, dispose: () => scope.stop() };
}
async function settle() { for (let i = 0; i < 5; i++) await vue.nextTick(); }

test("adding a lazy endpoint executes its plugin action once after the actual card becomes ready", async () => {
  const fixture = host(1);
  try {
    await settle();
    let added = 0;
    const card = { onAdded: async () => { added += 1; } };
    fixture.model.setCard("original-plugin-card", card);
    await settle();
    fixture.model.setCard("original-plugin-card", card);
    await settle();
    assert.equal(added, 1);
    assert.equal(fixture.model.busy.value, false);
    assert.deepEqual(fixture.emitted, [true, false]);
  } finally { fixture.dispose(); }
});

test("a failed plugin action stays on that card while another endpoint can change and keep its route identity", async () => {
  const failed = host();
  const other = host();
  try {
    const changes: boolean[] = [];
    failed.model.setCard("broken-card", { onEnabledChange: async () => { throw new Error("Endpoint action failed"); } });
    other.model.setCard("working-card", { onEnabledChange: async (enabled: boolean) => { changes.push(enabled); } });
    failed.props.enabled = false;
    other.props.enabled = false;
    await settle();
    assert.equal(failed.model.error.value, "Endpoint action failed");
    assert.equal(other.model.error.value, "");
    assert.deepEqual(changes, [false]);
    other.props.context = { routeId: "next-route", messageEndpointType: "test" };
    await settle();
    assert.deepEqual(changes, [false], "navigation must not replay an action against another Route");
    assert.equal(failed.model.busy.value, false);
    assert.equal(other.model.busy.value, false);
  } finally { failed.dispose(); other.dispose(); }
});
