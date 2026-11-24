import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";

test("the account dock opens login directly or saves a missing server before login", async () => {
  const file = new URL("../src/components/RabiAccountDock.vue", import.meta.url);
  const source = fs.readFileSync(file, "utf8");
  const { descriptor } = parse(source);
  assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename: file.pathname, id: "account-dock" }).errors, []);
  assert.doesNotMatch(source, /请在本机登录/);
  const code = transformSync(compileScript(descriptor, { id: "account-dock" }).content,
    { loader: "ts", format: "cjs" }).code;
  const require = createRequire(file);
  const vue = require("vue");
  const store = { meta: vue.reactive({ rabiLinkRelay: { enabled: false, url: "" } }) };
  let saved = false;
  let loginResult: "rejected" | "timeout" | "success" = "rejected";
  const module = { exports: {} as any };
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, AbortController, AbortSignal,
    require: (name: string) => {
      if (name === "vue") return { ...vue, onMounted() {}, onBeforeUnmount() {} };
      if (name.includes("gatewayStore")) return { useGatewayStore: () => store };
      if (name.endsWith("managerApi")) return {};
      if (name.endsWith("timeoutSettingsClient")) return { getTimeoutMs: () => 15 };
      if (name.endsWith("webguiLanRedirect")) return { isLoopbackHostname: () => false };
      throw new Error(name);
    },
    fetch: async (path: string, init: RequestInit) => {
      if (init.method === "PATCH") {
        writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
        return saved
          ? { ok: true, json: async () => ({ code: 0, data: { rabiLinkRelay: { enabled: true, url: "https://relay.example.test/" } } }) }
          : { ok: false, json: async () => ({ message: "保存失败" }) };
      }
      if (init.method === "POST") {
        writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
        if (loginResult === "rejected") return { ok: false, json: async () => ({ message: "账号或密码不正确。" }) };
        if (loginResult === "timeout") return {
          ok: true,
          json: () => new Promise((_resolve, reject) => {
            const signal = init.signal!;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          })
        };
        return { ok: true, json: async () => ({ account: { id: "fixture-id", username: "fixture" } }) };
      }
      return { ok: false };
    }
  });
  const scope = vue.effectScope();
  try {
    const dock = scope.run(() => module.exports.default.setup({}, { expose() {} }));
    dock.openAccount();
    assert.equal(dock.dialog.value, "configure");
    dock.serverUrl.value = "https://relay.example.test";
    await dock.saveServer();
    assert.equal(dock.dialog.value, "configure");
    assert.equal(dock.error.value, "保存失败");
    saved = true;
    await dock.saveServer();
    assert.equal(dock.dialog.value, "login");
    assert.deepEqual(writes.at(-1), { path: "/api/rabi/identity", method: "PATCH", body: { rabiLinkRelay: { enabled: true, url: "https://relay.example.test/" } } });
    dock.openAccount();
    assert.equal(dock.dialog.value, "login");
    await vue.nextTick();
    dock.username.value = "fixture";
    dock.password.value = "fixture-test-password";
    await dock.submit("login");
    assert.equal(dock.busy.value, false);
    assert.equal(dock.dialog.value, "login");
    assert.equal(dock.error.value, "账号或密码不正确。");
    loginResult = "timeout";
    const stalled = dock.submit("login");
    assert.equal(dock.busy.value, true);
    const keepAlive = setInterval(() => {}, 100);
    try { await stalled; } finally { clearInterval(keepAlive); }
    assert.equal(dock.busy.value, false);
    assert.equal(dock.dialog.value, "login");
    assert.match(dock.error.value, /响应超时/);
    loginResult = "success";
    await dock.submit("login");
    assert.equal(dock.dialog.value, null);
    assert.equal(dock.account.value.username, "fixture");
    assert.deepEqual(writes.at(-1), { path: "/api/rabilink/host-account", method: "POST", body: { action: "login", username: "fixture", password: "fixture-test-password" } });
  } finally {
    scope.stop();
  }
});

function mountDock(fetchImpl: (path: string, init: any) => Promise<any>) {
  const file = new URL("../src/components/RabiAccountDock.vue", import.meta.url);
  const source = fs.readFileSync(file, "utf8");
  const { descriptor } = parse(source);
  const code = transformSync(compileScript(descriptor, { id: "account-dock" }).content,
    { loader: "ts", format: "cjs" }).code;
  const require = createRequire(file);
  const vue = require("vue");
  const store = { meta: vue.reactive({ rabiLinkRelay: { enabled: true, url: "https://relay.example.test/" } }) };
  const module = { exports: {} as any };
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, AbortController, AbortSignal,
    require: (name: string) => {
      if (name === "vue") return { ...vue, onMounted() {}, onBeforeUnmount() {} };
      if (name.includes("gatewayStore")) return { useGatewayStore: () => store };
      if (name.endsWith("managerApi")) return {};
      if (name.endsWith("timeoutSettingsClient")) return { getTimeoutMs: () => 15000 };
      if (name.endsWith("webguiLanRedirect")) return { isLoopbackHostname: () => false };
      throw new Error(name);
    },
    fetch: fetchImpl
  });
  const scope = vue.effectScope();
  const dock = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  return { dock, scope };
}

test("the profile dialog saves a one-character nickname and a picked avatar without changing the login", async () => {
  const writes: Array<{ path: string; method: string; body: any }> = [];
  const { dock, scope } = mountDock(async (path: string, init: any) => {
    const method = init?.method || "GET";
    if (method === "GET" && path.endsWith("/profile")) {
      return { ok: true, status: 200, json: async () => ({ accountId: "fixture-id", username: "fixture-login", nickname: null }) };
    }
    if (method === "GET" && path.endsWith("/avatar")) {
      return { ok: true, status: 200, json: async () => ({ accountId: "fixture-id", avatar: null }) };
    }
    if (method === "GET") return { ok: true, status: 200, json: async () => ({ account: { id: "fixture-id", username: "fixture-login" } }) };
    writes.push({ path, method, body: JSON.parse(String(init.body)) });
    if (path.endsWith("/profile")) return { ok: true, status: 200, json: async () => ({ accountId: "fixture-id", username: "fixture-login", nickname: "雨" }) };
    return { ok: true, status: 200, json: async () => ({ accountId: "fixture-id", avatar: "AAAA" }) };
  });
  try {
    dock.account.value = { id: "fixture-id", username: "fixture-login" };
    dock.open("profile");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dock.dialog.value, "profile");
    assert.equal(dock.draftNickname.value, "");
    assert.equal(dock.nameUnavailable.value, "");
    assert.equal(dock.profileDirty.value, false);
    dock.draftNickname.value = "雨";
    dock.draft.value = "data:image/png;base64,AAAA";
    assert.equal(dock.profileDirty.value, true);
    await dock.saveProfile();
    assert.deepEqual(writes, [
      { path: "/api/rabilink/host-account/profile", method: "POST", body: { accountId: "fixture-id", nickname: "雨" } },
      { path: "/api/rabilink/host-account/avatar", method: "POST", body: { accountId: "fixture-id", avatar: "AAAA" } }
    ]);
    assert.equal(dock.account.value.username, "fixture-login");
    assert.equal(dock.displayName.value, "雨");
    assert.equal(dock.dialog.value, null);
    assert.equal(dock.error.value, "");
  } finally {
    scope.stop();
  }
});

test("the profile dialog keeps the nickname field disabled on a server without nickname support", async () => {
  const { dock, scope } = mountDock(async (path: string) => {
    if (path.endsWith("/profile")) {
      return { ok: false, status: 404, json: async () => ({ code: "RABILINK_RELAY_PROFILE_UNAVAILABLE" }) };
    }
    return { ok: true, status: 200, json: async () => ({ accountId: "fixture-id", avatar: null }) };
  });
  try {
    dock.account.value = { id: "fixture-id", username: "fixture-login" };
    dock.open("profile");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(dock.nameUnavailable.value, "更新服务器后可编辑昵称。");
    dock.draft.value = "data:image/png;base64,AAAA";
    assert.equal(dock.profileDirty.value, true);
  } finally {
    scope.stop();
  }
});
