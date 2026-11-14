import test from "node:test";
import assert from "node:assert/strict";
import { createAssistantPlayback } from "./assistantPlayback.js";

function fixture() {
  const listeners = new Set<(snapshot: { jobs: Record<string, unknown>[] }) => void>();
  const requests: any[] = [], cancelled: string[] = [], errors: unknown[] = [];
  let sequence = 0;
  const adapter = createAssistantPlayback({ voice: "selected-role", model: "selected-model", routeId: "selected-route",
    createId: () => String(++sequence), onError: error => errors.push(error),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    client: {
      synthesize: async command => { requests.push(command); return { playbackJob: `job-${requests.length}` }; },
      cancelPlaybackSession: async id => { cancelled.push(id); return { mode: "fifo", volume: 1, current: null, queued: 0, jobs: [] }; }
    }
  });
  return { adapter, requests, cancelled, errors, listeners,
    emit: (jobs: Record<string, unknown>[]) => { for (const listener of [...listeners]) listener({ jobs }); } };
}

test("host acceptance is not playback completion; only the scoped native terminal event ends output", async () => {
  const f = fixture();
  const job = await f.adapter.synthesize("reply");
  let ended = 0;
  job.player.audioPlayer.onEnded(() => ended++);
  await job.player.play();
  assert.equal(ended, 0);
  f.emit([{ id: "unrelated", session_id: "elsewhere", status: "done" }]);
  f.emit([{ id: "wrong", session_id: "assistant.1", status: "done" }]);
  assert.equal(ended, 0);
  f.emit([{ id: "job-1", session_id: "assistant.1", status: "done" }]);
  assert.equal(ended, 1);
  assert.equal(f.listeners.size, 0);
  await f.adapter.dispose();
  assert.deepEqual(f.cancelled, []);
});

test("barge-in cancels the original immutable scope once; later speech uses a fresh scope", async () => {
  const f = fixture(), signal = new AbortController();
  const old = await f.adapter.synthesize("old", { signal: signal.signal });
  await old.player.play();
  signal.abort();
  await old.task.abort();
  await old.player.stop();
  old.player.destroy();
  assert.deepEqual(f.cancelled, ["assistant.1"]);
  const next = await f.adapter.synthesize("new");
  await next.player.play();
  assert.equal(f.requests[1].sessionId, "assistant.2");
  assert.equal(f.requests[1].voice, "selected-role");
  assert.equal(f.requests[1].play, true);
  await f.adapter.dispose();
  assert.deepEqual(f.cancelled, ["assistant.1", "assistant.2"]);
});

test("abort before play makes no synthesis or cancellation request", async () => {
  const f = fixture();
  const job = await f.adapter.synthesize("never played");
  await job.task.abort();
  await job.player.play();
  assert.equal(f.requests.length, 0);
  assert.equal(f.cancelled.length, 0);
  assert.equal(f.listeners.size, 0);
});

test("real error remains an error, not a played receipt", async () => {
  const f = fixture(), job = await f.adapter.synthesize("reply");
  let ended = 0, failed = 0;
  job.player.audioPlayer.onEnded(() => ended++);
  job.player.audioPlayer.onError(() => failed++);
  await job.player.play();
  f.emit([{ id: "job-1", sessionId: "assistant.1", status: "error", error: "offline" }]);
  assert.equal(ended, 0);
  assert.equal(failed, 1);
  assert.equal(f.listeners.size, 0);
});

test("disposal joins a scoped cancellation already started by barge-in", async () => {
  let release!: () => void, calls = 0, disposed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = createAssistantPlayback({ voice: "role", model: "model", routeId: "route", createId: () => "one",
    subscribe: () => () => {}, onError() {}, client: {
      synthesize: async () => ({ playbackJob: "job" }),
      cancelPlaybackSession: async () => { calls++; await gate; return { mode: "fifo", volume: 1, current: null, queued: 0, jobs: [] }; }
    }
  });
  const job = await adapter.synthesize("hello");
  await job.player.play();
  const cancelling = job.task.abort();
  const disposal = adapter.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  assert.equal(calls, 1);
  release(); await Promise.all([cancelling, disposal]);
  assert.equal(disposed, true);
});
