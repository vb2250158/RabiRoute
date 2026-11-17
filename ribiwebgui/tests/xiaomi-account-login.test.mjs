import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse, compileScript } from "@vue/compiler-sfc";
import { transform } from "esbuild";

// Exercise the compiled component setup with a controllable HTTP boundary.
test("a timed-out login resumes its original waiting session without another begin", async () => {
  const filename = new URL("../../src/plugins/io.rabiroute.manager.xiaomi-home/web/components/XiaomiAccountLogin.vue", import.meta.url);
  const parsed = parse(fs.readFileSync(filename, "utf8"), { filename: filename.pathname });
  assert.deepEqual(parsed.errors, []);
  const script = compileScript(parsed.descriptor, { id: "test" }).content;
  const compiled = await transform(script, { loader: "ts", format: "cjs" });
  const waiting = { sessionId: "original-session", state: "waiting", expiresAt: new Date(Date.now() + 60000).toISOString(), imageDataUrl: "data:image/png;base64,AA==" };
  const calls = [];
  let statusReads = 0;
  const fetch = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    if (path === "/meta") return { ok: true, json: async () => ({ applicationGenerationId: "generation", managerInstanceId: "instance" }) };
    if (path.endsWith("/login")) throw new Error("connection interrupted after send");
    if (path.endsWith("/login/poll")) {
      assert.deepEqual(JSON.parse(options.body), { sessionId: "original-session" });
      return { ok: true, json: async () => ({ code: 0, data: { ...waiting, state: "connected", imageDataUrl: undefined } }) };
    }
    if (path.endsWith("/status")) return { ok: true, json: async () => ({ code: 0, data: ++statusReads === 1 ? { connected: false, login: waiting } : { connected: true } }) };
    throw new Error(`unexpected request ${path}`);
  };
  const vue = { defineComponent: value => value, ref: value => ({ value }), onMounted() {}, onBeforeUnmount() {} };
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: name => name === "vue" ? vue : { browserUuid: () => "fixed-uuid" },
    fetch, AbortController, AbortSignal, Date, Error, setTimeout, clearTimeout };
  vm.runInNewContext(compiled.code, context, { filename: "account-component.cjs" });
  const component = module.exports.default.setup({}, { expose() {} });
  await component.begin();
  assert.equal(component.connected.value, true);
  assert.equal(component.busy.value, false);
  assert.equal(calls.filter(call => call.path.endsWith("/login")).length, 1);
  assert.equal(calls.filter(call => call.path.endsWith("/login/poll")).length, 1);
});


test("fast waiting response is bounded and unmount cancels its pending poll", async () => {
  const filename = new URL("../../src/plugins/io.rabiroute.manager.xiaomi-home/web/components/XiaomiAccountLogin.vue", import.meta.url);
  const parsed = parse(fs.readFileSync(filename, "utf8"), { filename: filename.pathname });
  const script = compileScript(parsed.descriptor, { id: "test" }).content;
  const compiled = await transform(script, { loader: "ts", format: "cjs" });
  const waiting = { sessionId: "same-session", state: "waiting", expiresAt: new Date(Date.now() + 60000).toISOString() };
  const calls = [];
  let dispose;
  const fetch = async (path, options = {}) => {
    if (options.signal?.aborted) throw new Error("aborted");
    calls.push(path);
    if (path === "/meta") return { ok: true, json: async () => ({ applicationGenerationId: "generation", managerInstanceId: "instance" }) };
    if (path.endsWith("/login") || path.endsWith("/login/poll")) return { ok: true, json: async () => ({ code: 0, data: waiting }) };
    throw new Error(`unexpected request ${path}`);
  };
  const vue = { defineComponent: value => value, ref: value => ({ value }), onMounted() {}, onBeforeUnmount: callback => { dispose = callback; } };
  const module = { exports: {} };
  const context = { module, exports: module.exports, require: name => name === "vue" ? vue : { browserUuid: () => "fixed-uuid" },
    fetch, AbortController, AbortSignal, Date, Error, setTimeout, clearTimeout };
  vm.runInNewContext(compiled.code, context, { filename: "account-component.cjs" });
  const component = module.exports.default.setup({}, { expose() {} });
  const running = component.begin();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls.filter(path => path.endsWith("/login/poll")).length, 1);
  assert.equal(typeof dispose, "function");
  dispose();
  await running;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.filter(path => path.endsWith("/login/poll")).length, 1);
  assert.equal(component.busy.value, false);
});
