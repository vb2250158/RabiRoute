import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { compileScript, parse } from "@vue/compiler-sfc";
import { transformSync } from "esbuild";
import { DEFAULT_ALL_DAY_SETTINGS, type AllDayEvent } from "../../src/shared/allDayRecording";

const row = (id: string, time: number): AllDayEvent => ({ id, startedAt: time, endedAt: time, deviceId: "fixture", source: "window", kind: "window", text: id, state: "saved" });
function fixture(t: import("node:test").TestContext, fail = false, blockStatus = false, options: { days?: string[]; blockDay?: string; failDay?: string; incompleteDay?: string; emptyCache?: boolean; loadingDay?: string; pageLoading?: boolean; count?: number } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: options.days?.length ? Date.parse(options.days[1]??options.days[0])+300000 : 2000000000000 });
  const component = new URL("../src/components/PersonaAllDayRecording.vue", import.meta.url);
  const require = createRequire(component), vue = require("vue");
  const unmount: (() => void)[] = [], calls: string[] = [], handlers = new Map<string, (event: unknown) => void>();
  const deadlines = new Map<string,number>();
  const rows = Array.from({ length: options.count??600 }, (_, i) => row(`row-${i}`, options.days?.length ? i<300 ? Date.parse(options.days[0])+86400000-300000+i*1000 : Date.parse(options.days[1]??options.days[0])+(i-300)*1000 : Date.now() - i * 1000)).sort((a,b) => a.startedAt-b.startedAt);
  const storage = new Map([["all-day-preview:fixture", JSON.stringify({ at: Date.now(), events: options.emptyCache ? [] : rows })]]);
  let releaseStatus!: () => void;
  const statusWait = new Promise<void>(resolve => { releaseStatus = resolve; });
  let releaseDay!: () => void;
  const dayWait = new Promise<void>(resolve => { releaseDay = resolve; });
  let dayReleased = false;
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
        readAllDayResource: async (url: string, read: (reply: Response) => Promise<unknown>, _init: unknown, _signal: unknown, deadline: number) => {
        calls.push(url);
        deadlines.set(url,deadline);
        if (blockStatus && url.endsWith("/all-day-recording")) await statusWait;
        const day = new URL(url, "http://fixture").searchParams.get("day");
        if (day && day === options.failDay) throw new Error("Failed day read");
        if (fail && (url.includes("/events?") || url.endsWith("/catalog"))) throw new Error("Failed to fetch");
        const pendingDay=options.loadingDay || (!dayReleased ? options.blockDay : undefined);
        const data = url.includes("/page?") ? {events:[],hasMore:true,loading:options.pageLoading,pendingDays:pendingDay?[pendingDay]:[]} : day ? {events:[],days:[day],incompleteDays:day === options.incompleteDay || day===pendingDay ? [day] : [],loading:day===pendingDay} : url.includes("/catalog") ? { events: options.days?.length ? [] : rows, incompleteDays: [], days: options.days ?? [] } : url.endsWith("/recent") ? { events: [rows.at(-1)] } : url.includes("/events?") ? { events:rows.filter(row=>{const date=new Date(row.startedAt).toISOString().slice(0,10);return date!==pendingDay&&date!==options.failDay;}),loading:!!pendingDay,pendingDays:[pendingDay,options.failDay,options.incompleteDay].filter(Boolean),readError:options.failDay?"Failed day read":undefined } : { settings: DEFAULT_ALL_DAY_SETTINGS, enabled: false, running: false, activeRoleId: null, error: "" };
        return read(new Response(JSON.stringify({ code: 0, data })));
      } } : name.startsWith("@shared/") ? require("../../../src/shared/allDayRecording.ts") : require(name)
  });
  const scope = vue.effectScope();
  const model = scope.run(() => module.exports.default.setup({ roleId: "fixture" }, { expose() {} }));
  t.after(() => { releaseStatus(); releaseDay(); for (const fn of unmount) fn(); scope.stop(); });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); for (let i = 0; i < 12; i++) await vue.nextTick(); };
  return { model, calls, deadlines, rows, flush, releaseStatus, releaseDay:()=>{dayReleased=true;releaseDay();handlers.get("all_day_recording")?.({data:JSON.stringify({roleId:"fixture",readDay:options.blockDay})});}, ready: (readDay: string) => handlers.get("all_day_recording")?.({data:JSON.stringify({roleId:"fixture",readDay})}), changed: (indexDay?: string, indexFailed = false) => handlers.get("all_day_recording")?.({ data: JSON.stringify({ roleId: "fixture", indexDay, indexFailed }) }) };
}

test("cold snapshot acknowledgements retain history and navigation waits for readiness without spinning or rebuilding",async t=>{
  const options={days:["2033-05-17","2033-05-18"],loadingDay:"2033-05-17",pageLoading:true,emptyCache:true};
  const f=fixture(t,false,false,options);await f.flush();
  assert.equal(f.model.listEvents.value.length,300);
  assert.equal(f.calls.some(url=>url.includes("/index-repair/")),false);
  f.model.select(f.rows[300]);await f.flush();
  await f.model.adjacentEvent("older");await f.flush();
  assert.match(f.model.navigationMessage.value,/历史正在读取/);
  const calls=f.calls.length;await f.flush();t.mock.timers.tick(30000);await f.flush();
  assert.equal(f.calls.length,calls);
  assert.equal(f.model.selectedId.value,f.rows[300].id);
  options.loadingDay="";options.pageLoading=false;f.ready("2033-05-17");await f.flush();await f.flush();
  assert.equal(f.model.listEvents.value.length,600,JSON.stringify({calls:f.calls,error:f.model.historyError.value,cursor:f.model.cursor.value}));
  assert.equal(f.model.selectedId.value,f.rows[299].id);
  assert.equal(f.model.historyError.value,"");
});

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

test("capture status and preview timestamps do not present an old frame as live success", async t => {
  const f = fixture(t); await f.flush();
  f.model.state.value = { settings: { ...DEFAULT_ALL_DAY_SETTINGS, sources: { ...DEFAULT_ALL_DAY_SETTINGS.sources, screen: true } }, enabled: true,
    running: true, activeRoleId: "fixture", lastSampleAt: null, startedAt: Date.now(), error: "fetch failed", sourceErrors: { screen: "fetch failed" } };
  assert.equal(f.model.captureStatus.value.text, "采集失败"); assert.equal(f.model.captureStatus.value.color, "error");
  f.model.state.value.preparing = true;
  assert.equal(f.model.captureStatus.value.text, "正在准备采集环境");
  const old = f.rows[100]; f.model.select(old); await f.flush();
  f.model.cursor.value += 100000;
  assert.equal(f.model.previewTime.value, old.startedAt);
  const image = { ...old, id: "old-image", kind: "image", source: "screen", media: "media/old.jpg" };
  f.model.events.value = [...f.rows, image]; f.model.selectedId.value = image.id; await f.flush();
  f.model.displayedImage.value = "blob:older-frame"; f.model.displayedImageTime.value = old.startedAt - 1000;
  assert.equal(f.model.previewTime.value, old.startedAt - 1000);
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
  assert.equal(f.model.fetching.value, false);
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
  assert.match(f.model.historyError.value, /Failed day read/);
  const count = f.calls.length;
  f.model.cursor.value += 20000; await f.flush(); t.mock.timers.tick(20000); await f.flush();
  assert.equal(f.calls.length, count);
  assert.equal(f.model.listEvents.value.length, 300);
});

test("slow NAS history has a separate deadline from capture state and uses at most two day reads", async t => {
  const f = fixture(t,false,false,{days:["2033-05-17","2033-05-18","2033-05-19"],blockDay:"2033-05-18"});
  await f.flush();
  assert.equal(f.deadlines.get("/api/roles/fixture/all-day-recording"),12000);
  for(const [url,deadline] of f.deadlines) if(url.includes("/catalog")) assert.equal(deadline,60000);
  f.releaseDay(); await f.flush();
});

test("repair acknowledgement settles history immediately and SSE only reloads the repaired date", async t => {
  const options = {days:["2033-05-17","2033-05-18"],incompleteDay:"2033-05-17",emptyCache:true};
  const f = fixture(t,false,false,options); await f.flush();
  assert.equal(f.model.fetching.value,false);
  assert.equal(f.model.listEvents.value.length,600);
  assert.ok(f.calls.some(url => url.endsWith("/index-repair/2033-05-17")));
  assert.equal(f.calls.some(url => url.includes("/events?")),true);
  const before = f.calls.filter(url => url.endsWith("/catalog")).length;
  const selected = f.model.listEvents.value[10]; f.model.select(selected); await f.flush();
  options.incompleteDay = ""; f.changed("2033-05-17"); await f.flush();
  assert.equal(f.calls.filter(url => url.endsWith("/catalog")).length,before);
  assert.equal(f.model.historyMessage.value,"");
  assert.equal(f.model.selectedId.value,selected.id);
});

test("a notification queued behind a slow status read is drained after completion", async t => {
  const f = fixture(t,false,true); await f.flush();
  f.changed(); await f.flush();
  f.releaseStatus(); await f.flush();
  t.mock.timers.tick(600); await f.flush();
  assert.equal(f.calls.filter(url => url.endsWith("/all-day-recording")).length,2);
});

test("opening many historical dates only requests the viewport and does not eagerly fetch every day",async t=>{
  const days=Array.from({length:21},(_,i)=>new Date(Date.parse("2033-05-01")+i*86400000).toISOString().slice(0,10));
  const f=fixture(t,false,false,{days,emptyCache:true});await f.flush();
  assert.ok(f.calls.some(url=>url.includes("/events?")));
  assert.equal(f.calls.filter(url=>url.includes("/catalog?day=")).length,0);
  assert.equal(f.model.renderedEvents.value.length<=24,true);
});

test("oversized restored previews and subsequent updates retain a bounded, selectable browsing buffer",async t=>{
  const f=fixture(t,false,false,{count:5000});
  assert.equal(f.model.listEvents.value.length,2000);await f.flush();
  assert.equal(f.model.listEvents.value.length,2000);
  assert.equal(f.model.renderedEvents.value.length<=24,true);
  const selected=f.model.listEvents.value[100];f.model.select(selected);await f.flush();f.changed();t.mock.timers.tick(1000);await f.flush();
  assert.equal(f.model.selectedId.value,selected.id);
  assert.equal(f.model.listEvents.value.length,2000);
});

test("wide timeline coverage survives list eviction and selecting a marker restores its event",async t=>{
  const f=fixture(t,false,false,{count:5000});await f.flush();
  f.model.span.value=86400000;await f.model.loadRange();await f.flush();
  assert.equal(f.model.listEvents.value.length,2000);
  const markers=f.model.timelineMarkers.value;
  assert.equal(markers.reduce((sum:number,marker:{count:number})=>sum+marker.count,0),5000);
  const oldest=markers[0].event;assert.equal(f.model.events.value.some((row:AllDayEvent)=>row.id===oldest.id),false);
  f.model.select(oldest);await f.flush();
  assert.equal(f.model.selected.value.id,oldest.id);
  assert.equal(f.model.listEvents.value.length,2000);
});
