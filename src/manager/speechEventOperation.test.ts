import assert from "node:assert/strict";
import test from "node:test";
import { SpeechEventStreamOwner } from "./speechEventOperation.js";
import type { ApiOperationInput } from "./apiOperationContract.js";
const input = () => ({ signal: new AbortController().signal } as ApiOperationInput);

test("native speech SSE preserves comments, IDs, retry and non-JSON multiline UTF-8 bytes", async () => {
  const owner = new SpeechEventStreamOwner(), bytes = Buffer.from(": comment\nid: original\nretry: 123\nevent: native\ndata: hello\ndata: 世界\n\n");
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  const result = await owner.open(input(), async () => response, () => {}); assert.equal(result.status, 200);
  const chunks: Buffer[] = []; for await (const chunk of result.stream!.frames) chunks.push(Buffer.from(chunk as Uint8Array));
  assert.deepEqual(Buffer.concat(chunks), bytes); await owner.stop(); assert.equal(owner.activeCount(), 0);
});

test("native speech stream cancellation joins actual upstream reader cancellation", async () => {
  const owner = new SpeechEventStreamOwner(); let release!: () => void, cancelled = false;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(": hello\n\n")); }, async cancel() { cancelled = true; await cleanup; } }), { headers: { "content-type": "text/event-stream" } });
  const result = await owner.open(input(), async () => response, () => {}), iterator = result.stream!.frames[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  const cancelling = result.stream!.cancel(new Error("Controlled disconnect.")); let stopped = false; const stopping = owner.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(cancelled, true); assert.equal(stopped, false);
  release(); await cancelling; await iterator.return!(); await stopping; assert.equal(owner.activeCount(), 0);
});

test("never-started speech streams still cancel their original reader before retirement completes", async () => {
  const owner = new SpeechEventStreamOwner(); let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const response = new Response(new ReadableStream({ cancel() { return cleanup; } }), { headers: { "content-type": "text/event-stream" } });
  const result = await owner.open(input(), async () => response, () => {});
  const cancelling = result.stream!.cancel(new Error("Not consumed.")); let stopped = false; const stopping = owner.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release(); await cancelling; await stopping; assert.equal(owner.activeCount(), 0);
});

test("retirement during original upstream open waits for its actual completion and body cleanup", async () => {
  const owner = new SpeechEventStreamOwner(); let release!: () => void, sawAbort = false, cancelled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opening = owner.open(input(), async signal => { signal.addEventListener("abort", () => { sawAbort = true; }, { once: true }); await gate; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }); }, () => {}).catch(() => null);
  let stopped = false; const stopping = owner.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(sawAbort, true); assert.equal(stopped, false);
  release(); await opening; await stopping; assert.equal(cancelled, true); assert.equal(owner.activeCount(), 0);
});

test("upstream wrong media and failed responses retain native error statuses and cancel their bodies", async () => {
  for (const status of [200, 503]) {
    const owner = new SpeechEventStreamOwner(); let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { "content-type": "application/json" } });
    const result = await owner.open(input(), async () => response, () => {});
    assert.equal(result.status, status === 200 ? 502 : 503); assert.equal(cancelled, true); await owner.stop();
  }
});

test("a failed never-started upstream cancellation reaches terminal cleanup instead of orphaning the lease", async () => {
  const owner = new SpeechEventStreamOwner();
  const response = new Response(new ReadableStream({ cancel() { throw new Error("Controlled cancel failure."); } }), { headers: { "content-type": "text/event-stream" } });
  const result = await owner.open(input(), async () => response, () => {});
  await assert.rejects(Promise.resolve(result.stream!.cancel(new Error("Controlled retirement."))), /Controlled cancel failure/);
  await owner.stop(); assert.equal(owner.activeCount(), 0);
});

test("speech SSE fences each native chunk and aborts its original upstream after authority changes", async () => {
  const owner = new SpeechEventStreamOwner(); let revoked = false, aborted = false;
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const result = await owner.open(input(), async signal => new Response(new ReadableStream({ start(controller) { upstream = controller; controller.enqueue(Buffer.from("data: allowed\n\n")); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); } }), { headers: { "content-type": "text/event-stream" } }), () => { if (revoked) throw new Error("Controlled authority revoked."); });
  const frames = result.stream!.frames[Symbol.asyncIterator](); assert.equal(Buffer.from((await frames.next()).value as Uint8Array).toString(), "data: allowed\n\n");
  revoked = true; upstream.enqueue(Buffer.from("data: private-after-revocation\n\n")); await assert.rejects(frames.next(), /Controlled authority revoked/); assert.equal(aborted, true); await owner.stop(); assert.equal(owner.activeCount(), 0);
});
