import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";
import * as catalog from "../../src/plugins/io.rabiroute.manager.video/web/pages/workbenchAgentCatalog";

const page = new URL("../../src/plugins/io.rabiroute.manager.video/web/pages/WorkbenchAgentPicker.vue", import.meta.url);
const instances = [
  { instanceId: "this-pc", local: true, connected: true, agents: [{ agentId: "dsh-1", name: "DSH 主会话", provider: "dsh", enabled: true, workspace: "C:/work" }] },
  {
    instanceId: "other-pc", ownerDeviceId: "device-2", name: "书房电脑", local: false, connected: true,
    agents: [{ agentId: "codex-1", name: "Codex 会话", provider: "codex", enabled: true, sessionId: "native-thread" }],
  },
];
const responses: Record<string, unknown> = {
  "/api/video/v2/cli": { providers: [{ id: "codex", label: "Codex CLI", installUrl: "https://example.test", installed: true, ready: true, models: [{ id: "gpt-5", label: "GPT-5" }] }] },
  "/api/webgui-access": { data: { token: "fixture-token" } },
  "/api/lan-agent/instances": { code: 0, instances },
  "/api/device-agents": { code: 0, data: null },
  "/meta": { rabiLinkRelay: { deviceId: "this-device" } },
  "/api/rabilink/peer/list": { peers: [] },
  "/api/agent/threads": { code: 0, data: { action: "list", threads: [{ id: "t2", name: "会话二", projectPath: "D:/work/two" }] } },
};

const requests: { url: string; body: any }[] = [];
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : String(input);
  requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  const key = Object.keys(responses).find(path => url.includes(path));
  if (!key) throw new Error(`unexpected fetch ${url}`);
  return { ok: true, status: 200, json: async () => structuredClone(responses[key]) };
}) as typeof fetch;

const plain = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture(t: TestContext, props: Record<string, unknown>) {
  const require = createRequire(page), vue = require("vue");
  const descriptor = parse(fs.readFileSync(page, "utf8")).descriptor;
  const script = compileScript(descriptor, { id: "WorkbenchAgentPicker" });
  const template = compileTemplate({ source: descriptor.template!.content, filename: page.pathname, id: "WorkbenchAgentPicker", compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const emitted: { name: string; value: unknown }[] = [], cleanup: (() => void)[] = [];
  const module = { exports: {} as any };
  vm.runInNewContext(transformSync(script.content, { loader: "ts", format: "cjs" }).code, {
    module, exports: module.exports, structuredClone, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout,
    require: (dependency: string) => dependency === "vue"
      ? { ...vue, onMounted() {}, onBeforeUnmount: (fn: () => void) => cleanup.push(fn) }
      : dependency.includes("workbenchAgentCatalog") ? catalog : require(dependency),
  });
  const scope = vue.effectScope();
  const reactiveProps = vue.reactive(props);
  const model = scope.run(() => module.exports.default.setup(reactiveProps, { expose() {}, emit(name: string, value: unknown) { emitted.push({ name, value }); } }));
  t.after(() => { cleanup.forEach(fn => fn()); scope.stop(); });
  return { model, emitted, descriptor, props: reactiveProps, flush: () => vue.nextTick() };
}

test("CLI, this computer and other computers render as separate groups", async t => {
  await catalog.loadWorkbenchAgentCatalog(true);
  const f = fixture(t, {});
  const groups = plain(Array.from(f.model.groups.value, (group: any) => [group.label, group.entries.map((entry: any) => entry.label)]));
  assert.deepEqual(groups, [["本机 CLI", ["Codex CLI"]], ["本机已接入 Agent", ["DSH 主会话"]], ["其他电脑", ["Codex 会话"]]]);
  assert.match(f.descriptor.template!.content, /<optgroup v-for="group in groups"/);
  assert.match(f.descriptor.template!.content, /group\.label/);
});

test("choosing an installed CLI emits the CLI target and lists its models", async t => {
  await catalog.loadWorkbenchAgentCatalog(true);
  const f = fixture(t, {});
  f.model.chooseEntry("cli:codex");
  assert.deepEqual(plain(f.emitted.at(-1)?.value), { kind: "cli", provider: "codex" });
  f.props.modelValue = { kind: "cli", provider: "codex" };
  await f.flush();
  assert.deepEqual(plain(Array.from(f.model.cliModels.value, (model: any) => model.id)), ["gpt-5"]);
  f.model.chooseModel("gpt-5");
  assert.deepEqual(plain(f.emitted.at(-1)?.value), { kind: "cli", provider: "codex", model: "gpt-5" });
});

test("choosing a remote Agent binds its default session to the exact computer", async t => {
  await catalog.loadWorkbenchAgentCatalog(true);
  const f = fixture(t, {});
  f.model.chooseEntry("session:device-2:other-pc:codex-1");
  assert.deepEqual(plain(f.emitted.at(-1)?.value), {
    kind: "session", provider: "codex", threadId: "native-thread",
    instanceBinding: { instanceId: "other-pc", agentId: "codex-1", ownerDeviceId: "device-2" }, deviceName: "书房电脑", agentName: "Codex 会话",
  });
});

test("an Agent without a default session waits for an explicit session choice", async t => {
  await catalog.loadWorkbenchAgentCatalog(true);
  const f = fixture(t, {});
  f.model.chooseEntry("session:local:this-pc:dsh-1");
  assert.equal(f.emitted.at(-1)?.value, undefined);
});

test("a saved target missing from the catalogue stays visible instead of silently clearing", async t => {
  await catalog.loadWorkbenchAgentCatalog(true);
  const saved = { kind: "session" as const, provider: "dsh", threadId: "gone", agentName: "旧会话", instanceBinding: { instanceId: "old-pc", agentId: "dsh-9" } };
  const f = fixture(t, { modelValue: saved });
  assert.equal(f.model.missingSelection.value, true);
  const content = f.descriptor.template!.content;
  assert.match(content, /modelValue\?\.agentName \|\| modelValue\?\.provider/);
  assert.match(content, /（未在目录中）/);
});

test("an explicit session choice carries its workspace onto the node target", async t => {
  await catalog.loadWorkbenchAgentCatalog(true);
  const saved = { kind: "session" as const, provider: "dsh", threadId: "t1", agentName: "DSH 主会话", instanceBinding: { instanceId: "this-pc", agentId: "dsh-1" } };
  const f = fixture(t, { modelValue: saved });
  await f.flush();
  await f.model.readSessions();
  f.model.chooseSession("t2");
  assert.deepEqual(plain(f.emitted.at(-1)?.value), {
    kind: "session", provider: "dsh", threadId: "t2",
    instanceBinding: { instanceId: "this-pc", agentId: "dsh-1" }, cwd: "D:/work/two", agentName: "DSH 主会话",
  });
});

