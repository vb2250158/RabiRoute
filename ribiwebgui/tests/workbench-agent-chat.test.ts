import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import vm from "node:vm";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";
import * as catalog from "../../src/plugins/io.rabiroute.manager.video/web/pages/workbenchAgentCatalog";

const page = new URL("../../src/plugins/io.rabiroute.manager.video/web/pages/WorkbenchAgentChat.vue", import.meta.url);
const plain = (value: unknown) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const session = { kind: "session" as const, provider: "dsh", threadId: "thread-1", agentName: "DSH 主会话" };

const historyPage = {
  code: 0,
  data: {
    action: "read", agentAdapter: "dsh", threadId: "thread-1",
    history: {
      hasMore: false,
      records: [
        { event: { seq: 1, time: "2026-11-25T10:00:00Z", type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "帮我改一下开场" }] } } },
        { event: { seq: 2, time: "2026-11-25T10:00:05Z", type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "好的，我先看一版。" }] } } } },
        { event: { seq: 3, time: "2026-11-25T10:00:06Z", type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } },
      ],
    },
  },
};

const requests: { url: string; body: any }[] = [];
let reply: (url: string, body: any) => unknown = () => historyPage;
globalThis.fetch = (async (input: any, init: any) => {
  const url = typeof input === "string" ? input : String(input);
  const body = init?.body ? JSON.parse(init.body) : undefined;
  requests.push({ url, body });
  return { ok: true, status: 200, json: async () => structuredClone(reply(url, body)) };
}) as typeof fetch;

function fixture(t: TestContext, props: Record<string, unknown>) {
  const require = createRequire(page), vue = require("vue");
  const descriptor = parse(fs.readFileSync(page, "utf8")).descriptor;
  const script = compileScript(descriptor, { id: "WorkbenchAgentChat" });
  const template = compileTemplate({ source: descriptor.template!.content, filename: page.pathname, id: "WorkbenchAgentChat", compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const cleanup: (() => void)[] = [], mounted: (() => void)[] = [];
  const module = { exports: {} as any };
  vm.runInNewContext(transformSync(script.content, { loader: "ts", format: "cjs" }).code, {
    module, exports: module.exports, structuredClone, URL, URLSearchParams, AbortController, AbortSignal, setTimeout, clearTimeout, Date, JSON,
    require: (dependency: string) => dependency === "vue"
      ? { ...vue, onMounted: (fn: () => void) => mounted.push(fn), onBeforeUnmount: (fn: () => void) => cleanup.push(fn) }
      : dependency.includes("workbenchAgentCatalog") ? catalog : require(dependency),
  });
  const scope = vue.effectScope();
  const reactiveProps = vue.reactive(props);
  const model = scope.run(() => module.exports.default.setup(reactiveProps, { expose() {}, emit() {} }));
  mounted.forEach(fn => fn());
  t.after(() => { cleanup.forEach(fn => fn()); scope.stop(); });
  return { model, descriptor, props: reactiveProps, flush: async () => { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); } };
}

test("an Agent session opens on its real conversation", async t => {
  const before = requests.length;
  const f = fixture(t, { selection: session });
  await f.flush();
  assert.deepEqual(plain(Array.from(f.model.messages.value, (row: any) => [row.role, row.text])), [["user", "帮我改一下开场"], ["assistant", "好的，我先看一版。"]]);
  const read = requests.slice(before).find(row => row.body?.action === "read");
  assert.equal(read?.body.threadId, "thread-1");
  assert.equal(read?.body.agentAdapter, "dsh");
});

test("a CLI node explains that it has no session conversation", async t => {
  const f = fixture(t, { selection: { kind: "cli", provider: "codex" } });
  await f.flush();
  assert.equal(f.model.messages.value.length, 0);
  assert.match(f.descriptor.template!.content, /选择一个已接入的 Agent 会话/);
});

test("sending writes to the bound session and keeps the message visible", async t => {
  reply = () => ({ code: 0, data: { statusCode: 202 } });
  const before = requests.length;
  const f = fixture(t, { selection: session });
  await f.flush();
  f.model.draft.value = "  再短一点  ";
  await f.model.send();
  const sent = requests.slice(before).find(row => row.body?.action === "send");
  assert.equal(sent?.body.prompt, "再短一点");
  assert.equal(sent?.body.threadId, "thread-1");
  assert.equal(f.model.draft.value, "");
  assert.equal(f.model.messages.value.at(-1).text, "再短一点");
  assert.equal(f.model.receipt.value, "已投递，等待对方回复。");
  assert.equal(f.model.sending.value, false);
  reply = () => historyPage;
});

test("a failed history read stays visible and does not fabricate messages", async t => {
  reply = () => ({ code: -1, message: "会话读取失败" });
  const f = fixture(t, { selection: session });
  await f.flush();
  assert.equal(f.model.messages.value.length, 0);
  assert.match(f.model.error.value, /会话读取失败/);
  reply = () => historyPage;
});

test("an empty draft cannot be sent", async t => {
  const before = requests.filter(row => row.body?.action === "send").length;
  const f = fixture(t, { selection: session });
  await f.flush();
  f.model.draft.value = "   ";
  assert.equal(f.model.canSend.value, false);
  await f.model.send();
  assert.equal(requests.filter(row => row.body?.action === "send").length, before);
});
