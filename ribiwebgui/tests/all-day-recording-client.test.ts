import test from "node:test";
import assert from "node:assert/strict";
import { readAllDayResource } from "../src/allDayRecordingClient";

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
