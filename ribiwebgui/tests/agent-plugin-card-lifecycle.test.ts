import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";

function card(fetcher: typeof fetch) {
  const source = fs.readFileSync(new URL("../src/agentAdapters/CopilotCliAgentCard.vue", import.meta.url), "utf8");
  const script = compileScript(parse(source).descriptor, { id: "copilot-card-lifecycle" });
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  type Model = { startCopilotLogin(): Promise<void>; copilotLoginState: vue.Ref<{ code: string | null }> };
  const module: { exports: { default?: { setup(props: object, context: object): Model } } } = { exports: {} };
  const cleanup: Array<() => void> = [];
  let opened = 0, closed = 0;
  vm.runInNewContext(code, {
    module, exports: module.exports, fetch: fetcher,
    require(name: string) {
      if (name === "vue") return { ...vue, onMounted() {}, onBeforeUnmount(dispose: () => void) { cleanup.push(dispose); } };
      if (name === "../stores/gatewayStore") return { useGatewayStore: () => ({ selectedGateway: { id: "route", copilotCwd: "D:/Work" } }) };
      if (name === "@shared/routeAgentTargets") return { resolvePrimaryAgentTarget: () => ({ id: "local:copilotCli", provider: "copilotCli" }) };
      if (name === "../managerApi") return { managerEventSource() { opened++; return { addEventListener() {}, close() { closed++; } }; } };
      throw new Error(`Unexpected Copilot card dependency: ${name}`);
    }
  });
  const model = module.exports.default!.setup({ context: { routeId: "route", runtime: {}, scanState: { agents: {} }, touch() {} } }, { expose() {} });
  return { model, dispose: () => cleanup.forEach(dispose => dispose()), subscriptions: () => ({ opened, closed }) };
}

test("removing a Copilot card closes only its UI subscription while the accepted login remains with its owner", async () => {
  const requests: string[] = [];
  const item = card(async input => { requests.push(String(input)); return Response.json({ code: "fixture-device-code", url: "https://example.invalid/login" }); });
  await item.model.startCopilotLogin();
  assert.equal(item.model.copilotLoginState.value.code, "fixture-device-code");
  assert.deepEqual(item.subscriptions(), { opened: 1, closed: 0 });
  item.dispose();
  assert.deepEqual(item.subscriptions(), { opened: 1, closed: 1 });
  assert.deepEqual(requests, ["/api/agent/copilot-login"]);
});

test("a login accepted before card removal cannot later create an orphan subscription", async () => {
  let resolve!: (response: Response) => void;
  const item = card(() => new Promise(yes => { resolve = yes; }));
  const pending = item.model.startCopilotLogin();
  item.dispose();
  resolve(Response.json({ code: "late-owner-code", url: "https://example.invalid/login" }));
  await pending;
  assert.deepEqual(item.subscriptions(), { opened: 0, closed: 0 });
});
