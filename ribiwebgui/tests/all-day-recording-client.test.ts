import test from "node:test";
import assert from "node:assert/strict";
import { readAllDayResource, recordingPreview, restoreRecordingPreview, rememberRecordingPreview } from "../src/allDayRecordingClient";
import type { AllDayEvent } from "../../src/shared/allDayRecording";

test("recording deadline includes stalled image bodies and never retries", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    calls++;
    return { blob: () => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }) };
  });
  await assert.rejects(readAllDayResource("/recording", response => response.blob(), {}, undefined, 20), { name: "TimeoutError" });
  assert.equal(calls, 1);
});

test("changing persona cancels the read without reporting a server timeout", async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  const pending = readAllDayResource("/recording", response => response.json(), {}, controller.signal, 1000);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("successful reads release their deadline and preserve request options", async t => {
  let captured: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    captured = init;
    return new Response(JSON.stringify({ code: 0 }), { headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await readAllDayResource("/recording", response => response.json(), { method: "PUT", body: "{}" }, undefined, 20), { code: 0 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(captured?.method, "PUT");
  assert.equal(captured?.body, "{}");
  assert.equal(captured?.signal?.aborted, false);
});

test("recording preview preserves the entire event list and stays persona-scoped", t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  const events: AllDayEvent[] = Array.from({ length: 1200 }, (_, i) => ({ id: `item-${i}`, startedAt: i, endedAt: i, source: "window", deviceId: "test", kind: "window", text: "", state: "saved" }));
  rememberRecordingPreview("preview-fixture", events);
  assert.equal(recordingPreview("preview-fixture").length, 1200);
  assert.equal(JSON.parse(stored.get("all-day-preview:preview-fixture")!).events.length, 1200);
  assert.deepEqual(recordingPreview("other-fixture"), []);
});

test("large history restores from IndexedDB after memory eviction instead of the 200-event fallback", async t => {
  const storage = new Map<string,string>(), records = new Map<string,unknown>();
  const descriptors = ["localStorage", "indexedDB"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis,name)] as const);
  const db: any = { close() {}, transaction() {
    const tx: any = { abort() { tx.onabort?.(); }, objectStore() { return {
      put(value: unknown, key: string) { records.set(key,structuredClone(value)); queueMicrotask(() => tx.oncomplete?.()); return {}; },
      get(key: string) { const request = {result:structuredClone(records.get(key))}; queueMicrotask(() => tx.oncomplete?.()); return request; }
    }; } }; return tx;
  } };
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)}});
  Object.defineProperty(globalThis,"indexedDB",{configurable:true,value:{open(){const request:any={result:db};queueMicrotask(()=>request.onsuccess?.());return request;}}});
  t.after(() => { db.onversionchange?.(); for (const [name,descriptor] of descriptors) { if(descriptor) Object.defineProperty(globalThis,name,descriptor); else Reflect.deleteProperty(globalThis,name); } });
  const events:AllDayEvent[] = Array.from({length:36018},(_,i)=>({id:`large-${i}`,startedAt:i,endedAt:i,source:"window",deviceId:"fixture",kind:"window",text:"event".repeat(50),state:"saved"}));
  rememberRecordingPreview("large-preview-fixture",events);
  for(let i=0;i<4;i++) rememberRecordingPreview(`evict-${i}`,[]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(recordingPreview("large-preview-fixture").length,200);
  assert.equal((await restoreRecordingPreview("large-preview-fixture")).length,36018);
  assert.equal(recordingPreview("large-preview-fixture").length,36018);
});
