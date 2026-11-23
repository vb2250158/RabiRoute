import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";
import * as vue from "vue";
import { NapcatState } from "../../src/shared/napcatStateContract";
import { napcatLoginErrorMessage } from "../../src/plugins/io.rabiroute.endpoint.napcat/web/napcatLoginPresentation";

async function settle() { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); }

function panel(loginRequested: boolean, read?: (init: RequestInit) => Promise<unknown>) {
  const file = new URL("../../src/plugins/io.rabiroute.endpoint.napcat/web/messageEndpoints/NapcatEndpointCard.vue", import.meta.url);
  const code = transformSync(compileScript(parse(fs.readFileSync(file, "utf8")).descriptor,
    { id: "napcat-panel-test" }).content, { loader: "ts", format: "cjs" }).code;
  const store = vue.reactive({ loading: false, dirty: false,
    selectedGateway: { id: "fixture", enabled: true, messageAdapters: ["napcat"],
      napcatInstances: [{ id: "account", enabled: true, botUserId: "10000" }] },
    selectedRuntime: {} });
  const requests: string[] = [];
  const module = { exports: {} as any };
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, URLSearchParams, console, AbortController, AbortSignal,
    window: { setTimeout: () => 1, clearTimeout() {} },
    require(name: string) {
      if (name === "vue") return { ...vue, onMounted() {}, onBeforeUnmount() {} };
      if (name === "vue-router") return { useRoute: () => ({ query: {} }) };
      if (name.includes("gatewayStore")) return { useGatewayStore: () => store };
      if (name.includes("napcatStateContract")) return { NapcatState };
      if (name.includes("napcatLoginPresentation")) return { napcatLoginErrorMessage };
      if (name.includes("timeoutSettingsClient")) return { getTimeoutMs: () => 25 };
      if (name.includes("gatewayHelpers")) return { gatewayAdapterTypes: () => ["napcat"],
        isMessageInputsDisabled: () => false };
      if (name.includes("userFacingError")) return { userFacingError: (e: Error) => e.message };
      if (name.endsWith(".vue") || name.includes("napcatRuntimeEndpoint")) return {};
      throw Error(name);
    },
    fetch: async (path: string, init: RequestInit) => {
      requests.push(path);
      return { ok: true, json: async () => read ? read(init) : ({ ok: true, loggedIn: true, state: "logged-in",
        expectedUserId: "10000", currentAccount: { userId: "10000" }, quickAccounts: [] }) };
    }
  });
  const scope = vue.effectScope();
  const props = vue.reactive({ context: { routeId: "fixture", active: true, loginRequested } });
  let model: any;
  try { model = scope.run(() => module.exports.default.setup(props, { expose() {} })); }
  catch (error) { scope.stop(); throw error; }
  return { model, store, props, requests, dispose: () => scope.stop() };
}

test("native QR rejection appears on the first response without its account envelope", async () => {
  const text = "请登录最新手机 QQ 并根据提示恢复账号使用。";
  const f = panel(true, async () => ({ ok: true, loggedIn: false,
    loginError: `登录失败: [1,{"account":"10000","serverErrorCode":168,"message":"${text}"}]` }));
  try {
    await settle();
    assert.equal(f.model.napcatLoginUi(f.store.selectedGateway.napcatInstances[0]).error, text);
    assert.equal(f.requests.length, 1, "a native rejection must not trigger another login action");
    assert.equal(napcatLoginErrorMessage("二维码已过期，请刷新"), "二维码已过期，请刷新");
    assert.equal(napcatLoginErrorMessage('登录失败: [1,{"account":"10000"}]'), "QQ 登录失败，请在手机 QQ 查看登录提示后重试。");
  } finally { f.dispose(); }
});

test("a stalled response body releases loading, retains the QR and allows the next status check", async () => {
  let stalled = false;
  const f = panel(true, async init => stalled
    ? new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
    : { ok: true, loggedIn: false, qrCodeDataUrl: "fixture-qr", quickAccounts: [] });
  try {
    await settle();
    const instance = f.store.selectedGateway.napcatInstances[0];
    const ui = f.model.napcatLoginUi(instance);
    stalled = true;
    const keepAlive = setInterval(() => {}, 50);
    try { await f.model.loadNapcatLoginPanel(instance); } finally { clearInterval(keepAlive); }
    assert.equal(ui.loading, false);
    assert.equal(ui.panel.qrCodeDataUrl, "fixture-qr");
    assert.match(ui.error, /超时/);
    stalled = false;
    await f.model.loadNapcatLoginPanel(instance);
    assert.equal(ui.error, "");
  } finally { f.dispose(); }
});

test("switching Route rejects the late response and initializes the new Route once", async () => {
  const reads: Array<{ complete: (value: unknown) => void; init: RequestInit }> = [];
  const f = panel(false, init => new Promise(complete => reads.push({ complete, init })));
  try {
    await settle();
    f.store.selectedGateway = { ...f.store.selectedGateway, id: "next" };
    f.props.context = { ...f.props.context, routeId: "next" };
    await settle();
    assert.equal(reads.length, 2);
    assert.equal(reads[0].init.signal!.aborted, true);
    reads[1].complete({ ok: true, loggedIn: false, loginError: "新的登录状态" });
    reads[0].complete({ ok: true, loggedIn: true });
    await settle();
    const ui = f.model.napcatLoginUi(f.store.selectedGateway.napcatInstances[0]);
    assert.equal(ui.panel.loggedIn, false);
    assert.equal(ui.error, "新的登录状态");
  } finally { f.dispose(); }
});

for (const requested of [true, false]) {
  test(`NapCat ${requested ? "login" : "settings"} panel publishes the first login response`, async () => {
    const f = panel(requested);
    try {
      for (let n = 0; n < 6; n++) await vue.nextTick();
      const ui = f.model.napcatLoginUi(f.store.selectedGateway.napcatInstances[0]);
      assert.equal(ui.panel?.loggedIn, true);
      assert.equal(ui.loading, false);
      assert.equal(f.requests.length, 1);
    } finally { f.dispose(); }
  });
}
