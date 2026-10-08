import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";
import { DEFAULT_ALL_DAY_SETTINGS, type AllDayEvent } from "../../src/shared/allDayRecording";

const row = (id: string, time: number): AllDayEvent => ({ id, startedAt: time, endedAt: time, deviceId: "fixture", source: "window", kind: "window", text: id, state: "saved" });
function fixture(t: import("node:test").TestContext, fail = false, blockStatus = false, options: { days?: string[]; blockDay?: string; failDay?: string; emptyCache?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2000000000000 });
  const component = new URL("../src/components/PersonaAllDayRecording.vue", import.meta.url);
  const require = createRequire(component), vue = require("vue");
  const unmount: (() => void)[] = [], calls: string[] = [], handlers = new Map<string, (event: unknown) => void>();
  const rows = Array.from({ length: 600 }, (_, i) => row(`row-${i}`, options.days?.length ? Date.parse(options.days[i < 300 ? 0 : 1]) + i : Date.now() - i * 1000)).sort((a,b) => a.startedAt-b.startedAt);
  const storage = new Map([["all-day-preview:fixture", JSON.stringify({ at: Date.now(), events: options.emptyCache ? [] : rows })]]);
  let releaseStatus!: () => void;
  const statusWait = new Promise<void>(resolve => { releaseStatus = resolve; });
  let releaseDay!: () => void;
  const dayWait = new Promise<void>(resolve => { releaseDay = resolve; });
  const code = transformSync(compileScript(parse(fs.readFileSync(component, "utf8")).descriptor, { id: "recording-loading" }).content, { loader: "ts", format: "cjs" }).code;
  const module = { exports: {} as any };
  vm.runInNewContext(code, { module, exports: module.exports, AbortController, AbortSignal, URL, URLSearchParams, structuredClone, Date, performance,
    setTimeout, clearTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    require: (name: string) => name === "vue" ? { ...vue, onBeforeUnmount: (fn: () => void) => unmount.push(fn) } :
      name.endsWith("i18n") ? { useI18n: () => ({ isEnglish: vue.ref(false) }) } :
      name.endsWith("managerApi") ? { managerEventSource: () => ({ close() {}, addEventListener: (key: string, fn: (event: unknown) => void) => handlers.set(key, fn) }) } :
      name.endsWith("allDayRecordingClient") ? {
        recordingPreview: (role: string) => JSON.parse(storage.get(`all-day-preview:${role}`) || "null")?.events ?? [],
        restoreRecordingPreview: async () => [],
        rememberRecordingPreview: (role: string, events: AllDayEvent[]) => storage.set(`all-day-preview:${role}`, JSON.stringify({at: Date.now(), events})),
        readAllDayResource: async (url: string, read: (reply: Response) => Promise<unknown>) => {
        calls.push(url);
        if (blockStatus && url.endsWith("/all-day-recording")) await statusWait;
        const day = new URL(url, "http://fixture").searchParams.get("day");
        if (day && day === options.blockDay) await dayWait;
        if (day && day === options.failDay) throw new Error("Failed day read");
        if (fail && (url.includes("/events?") || url.endsWith("/catalog"))) throw new Error("Failed to fetch");
        const data = day ? {events:rows.filter(row => new Date(row.startedAt).toISOString().slice(0,10) === day),days:[day],incompleteDays:[]} : url.endsWith("/catalog") ? { events: options.days?.length ? [] : rows, incompleteDays: [], days: options.days ?? [] } : url.endsWith("/recent") ? { events: [rows.at(-1)] } : url.includes("/events?") ? { events: [] } : { settings: DEFAULT_ALL_DAY_SETTINGS, enabled: false, running: false, activeRoleId: null, error: "" };
        return read(new Response(JSON.stringify({ code: 0, data })));
      } } : name.startsWith("@shared/") ? require("../../../src/shared/allDayRecording.ts") : require(name)
  });
  const scope = vue.effectScope();
  const model = scope.run(() => module.exports.default.setup({ roleId: "fixture" }, { expose() {} }));
  t.after(() => { releaseStatus(); releaseDay(); for (const fn of unmount) fn(); scope.stop(); });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); for (let i = 0; i < 12; i++) await vue.nextTick(); };
  return { model, calls, rows, flush, releaseStatus, releaseDay, changed: () => handlers.get("all_day_recording")?.({ data: JSON.stringify({ roleId: "fixture" }) }) };
}

test("opening recording exposes every cached event before the server responds and retains history after recent updates", async t => {
  const f = fixture(t);
  assert.equal(f.model.listEvents.value.length, 600);
  await f.flush();
  assert.equal(f.model.listEvents.value.length, 600);
  assert.ok(f.calls.some(url => url.endsWith("/catalog")));
  assert.equal(f.model.fetching.value, false);
  f.model.select(f.rows[100]);
  await f.flush();
  assert.equal(f.model.selectedId.value, f.rows[100].id);
});

test("failed history reads settle and the real-time clock does not restart them every second", async t => {
  const f = fixture(t, true);
  await f.flush();
  const count = f.calls.length;
  for (let i = 0; i < 20; i++) { f.model.cursor.value += 1000; await f.flush(); t.mock.timers.tick(1500); await f.flush(); }
  assert.equal(f.calls.length, count);
  assert.equal(f.model.fetching.value, false);
  assert.equal(f.model.listEvents.value.length, 600);
});

test("capture notifications refresh recent events without rescanning history or interrupting selection", async t => {
  const f = fixture(t);
  await f.flush(); f.model.select(f.rows[100]); await f.flush();
  const historyReads = () => f.calls.filter(url => url.includes("/events?") || url.endsWith("/catalog")).length;
  const before = historyReads();
  f.changed(); t.mock.timers.tick(1000); await f.flush();
  assert.equal(historyReads(), before);
  assert.equal(f.model.selectedId.value, f.rows[100].id);
  assert.equal(f.model.listEvents.value.length, 600);
});

test("notifications do not continually cancel the pending capture-state read", async t => {
  const f = fixture(t, false, true);
  await f.flush();
  for (let i = 0; i < 4; i++) { f.changed(); t.mock.timers.tick(1000); await f.flush(); }
  assert.equal(f.calls.filter(url => url.endsWith("/all-day-recording")).length, 1);
  assert.equal(f.model.listEvents.value.length, 600);
  f.releaseStatus(); await f.flush();
  assert.equal(f.model.state.value.running, false);
});

test("day indexes render progressively and can be selected while a slower day is still pending", async t => {
  const f = fixture(t, false, false, { days:["2033-05-17","2033-05-18"], blockDay:"2033-05-17", emptyCache:true });
  await f.flush();
  assert.equal(f.model.listEvents.value.length, 300);
  assert.equal(f.model.fetching.value, true);
  const selected = f.model.listEvents.value[10]; f.model.select(selected); await f.flush();
  f.releaseDay(); await f.flush();
  assert.equal(f.model.listEvents.value.length, 600);
  assert.equal(f.model.selectedId.value, selected.id);
  assert.equal(f.model.fetching.value, false);
});

test("one failed day does not discard successful days or restart after the live clock ticks", async t => {
  const f = fixture(t, false, false, { days:["2033-05-17","2033-05-18"], failDay:"2033-05-17", emptyCache:true });
  await f.flush();
  assert.equal(f.model.listEvents.value.length, 300);
  assert.equal(f.model.fetching.value, false);
  assert.match(f.model.error.value, /Failed day read/);
  const count = f.calls.length;
  f.model.cursor.value += 20000; await f.flush(); t.mock.timers.tick(20000); await f.flush();
  assert.equal(f.calls.length, count);
  assert.equal(f.model.listEvents.value.length, 300);
});
