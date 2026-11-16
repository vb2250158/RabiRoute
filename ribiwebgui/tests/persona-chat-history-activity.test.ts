import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";

/** Execute the real component setup/watchers without a browser or real Manager. */
function fixture(t: import("node:test").TestContext) {
  const component = new URL("../../src/plugins/io.rabiroute.manager.persona/web/components/PersonaChatHistory.vue", import.meta.url);
  const require = createRequire(component), vue = require("vue");
  const unmount: Array<() => void> = [];
  const summary = { id: "pending-body", receivedAt: "2026-11-05T08:00:00Z", sessionId: "task-a",
    historyCursor: 42, text: "Summary", textTruncated: true };
  const summaryUrls: URL[] = [];
  let bodySignal: AbortSignal | undefined, releaseBody!: () => void;
  const bodyWait = new Promise<void>(resolve => { releaseBody = resolve; });
  const fetch = async (input: string, init: { signal: AbortSignal }) => {
    const url = new URL(input, "http://fixture");
    if (!url.searchParams.has("summary")) {
      bodySignal = init.signal;
      // Deliberately ignore cancellation at the transport layer: the component must reject a late result too.
      await bodyWait;
      return { ok: true, json: async () => ({ code: 0, data: { entries: [{ ...summary, text: "Late full body" }], nextCursor: null } }) };
    }
    summaryUrls.push(url);
    return { ok: true, json: async () => ({ code: 0, data: { entries: [summary], nextCursor: null } }) };
  };
  const source = fs.readFileSync(component, "utf8");
  const code = transformSync(compileScript(parse(source).descriptor, { id: "chat-history-activity" }).content,
    { loader: "ts", format: "cjs" }).code;
  const module = { exports: {} as any };
  const pane={scrollTop:0,scrollHeight:800,clientHeight:800,addEventListener(){},removeEventListener(){}};
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, URL, URLSearchParams,
    window: { innerHeight: 800 }, document: { scrollingElement: { scrollTop: 0 } },
    require: (name: string) => name === "vue" ? { ...vue,
      onBeforeUnmount: (fn: () => void) => unmount.push(fn), onActivated() {}, onDeactivated() {} } :
      name.endsWith(".vue") ? {} :
      name.endsWith("personaServiceClient") ? { usePersonaService: () => ({ fetch }) } :
      name.endsWith("i18n/index") ? { useI18n: () => ({ t: (value: string) => value, locale: vue.ref("zh-CN") }) } :
      name.endsWith("personaChatHistoryLayout") ? { chatHistoryScroller:()=>pane,chatHistoryViewport:()=>({top:0,bottom:800}),waitForChatHistoryFrame:async()=>false } :
      name.endsWith("markdownPreview") ? { renderMarkdownPreview: (value: string) => value } :
      require(name)
  });
  const props = vue.reactive({ roleId: "role-a", version: 1, active: true, conversation: false });
  const scope = vue.effectScope();
  const model = scope.run(() => module.exports.default.setup(props, { expose() {} }));
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick(); };
  t.after(() => { releaseBody(); for (const fn of unmount) fn(); scope.stop(); });
  return { props, model, summary, summaryUrls, flush, releaseBody, signal: () => bodySignal };
}

test("hiding a history channel cancels its full-text read and closes details without evicting retained bodies", async t => {
  const f = fixture(t);
  await f.flush();
  assert.equal(f.model.entries.value.length, 1);
  f.model.bodyCache.value.set("retained-body", "Previously expanded content");
  f.model.expandedBodies.value.add("retained-body");
  f.model.detailsEntry.value = f.model.entries.value[0];
  const pending = f.model.expandBody(f.model.entries.value[0]);
  assert.equal(f.signal()?.aborted, false);
  assert.equal(f.model.bodyLoading.value, f.summary.id);

  f.props.active = false;
  await f.flush();
  assert.equal(f.signal()?.aborted, true, "v-show inactivity must cancel the full-text request, without waiting for deactivation");
  assert.equal(f.model.detailsEntry.value, undefined);
  assert.equal(f.model.bodyLoading.value, undefined);
  assert.equal(f.model.bodyCache.value.get("retained-body"), "Previously expanded content");

  f.releaseBody();
  await pending;
  await f.flush();
  assert.equal(f.model.bodyCache.value.has(f.summary.id), false, "a late response from the hidden channel cannot populate its cache");
  assert.equal(f.model.expandedBodies.value.has(f.summary.id), false);
  assert.equal(f.model.bodyCache.value.size, 1);
  assert.equal(f.model.expandedBodies.value.has("retained-body"), true);
});


test("automatic chat reads use recorded metadata while explicit refresh can update task names", async t => {
  const f = fixture(t);
  await f.flush();
  assert.equal(f.summaryUrls.length, 1);
  assert.equal(f.summaryUrls[0].searchParams.get('metadata'), 'recorded');
  await f.model.load(false, false, false, true);
  assert.equal(f.summaryUrls.at(-1)!.searchParams.has('metadata'), false);
  f.props.version++;
  await f.flush();
  assert.equal(f.summaryUrls.at(-1)!.searchParams.get('metadata'), 'recorded');
});


test("history page reads once on first event connection and refreshes after reconnect", () => {
  const component = new URL("../../src/plugins/io.rabiroute.manager.persona/web/pages/RoleMessageHistoryPage.vue", import.meta.url);
  const require = createRequire(component), vue = require("vue");
  const mounted: Array<() => void> = [], handlers = new Map<string, (event?: unknown) => void>();
  const code = transformSync(compileScript(parse(fs.readFileSync(component, 'utf8')).descriptor, {id:'history-ready'}).content,
    {loader:'ts',format:'cjs'}).code;
  const module = {exports:{} as any};
  vm.runInNewContext(code, {module,exports:module.exports,require:(name:string)=>
    name==='vue'?{...vue,onMounted:(fn:()=>void)=>mounted.push(fn),onBeforeUnmount(){}}:
    name==='vue-router'?{useRoute:()=>({params:{roleId:'role-a'},query:{}})}:
    name.endsWith('.vue')?{}:
    name.endsWith('personaServiceClient')?{providePersonaService:()=>({events:()=>({addEventListener:(event:string,fn:()=>void)=>handlers.set(event,fn)})})}:
    name.endsWith('i18n/index')?{useI18n:()=>({t:(s:string)=>s})}:require(name)});
  const model = module.exports.default.setup({}, {expose(){}});
  mounted.forEach(fn=>fn());
  handlers.get('ready')!();
  assert.equal(model.version.value,0);
  assert.equal(model.messageVersion.value,0);
  handlers.get('ready')!();
  assert.equal(model.version.value,1);
  assert.equal(model.messageVersion.value,1);
  handlers.get('persona_chat_history_changed')!({data:JSON.stringify({roleId:'role-a'})});
  assert.equal(model.version.value,2);
});
