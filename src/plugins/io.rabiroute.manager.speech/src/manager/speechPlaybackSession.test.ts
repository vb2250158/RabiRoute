import assert from "node:assert/strict";
import test from "node:test";
import { ManagerSpeechControl } from "./speechControl.js";

function fixture() {
  const calls: { url: string; path: string; body: unknown }[] = [];
  let release: (() => void) | undefined;
  const control = new ManagerSpeechControl({ serviceUrl: () => "http://127.0.0.1:19001",
    personas: () => [], routes: () => [], route: () => undefined,
    deliverTranscript: async () => ({ status: "delivered" }), appendRouteLog: () => {},
    localSpeech: {
      inspect: async () => { throw new Error("unused"); },
      requestBinary: async () => { throw new Error("unused"); },
      requestJson: async (url, path, init) => {
        calls.push({ url, path, body: JSON.parse(String(init?.body)) });
        if (release) await new Promise<void>(resolve => { release = resolve; });
        return { status: 200, data: { mode: "fifo", volume: 1, current: "other", queued: 1,
          jobs: [{ id: "other", session_id: "other-session", status: "playing" }] } };
      }
    }
  });
  return { control, calls, defer: () => { release = () => {}; }, release: () => release?.() };
}

test("scoped cancellation forwards exact scope and retains unrelated playback state", async () => {
  const f = fixture();
  const status = await f.control.cancelPlaybackSession({ sessionId: "assistant.one" });
  assert.deepEqual(f.calls, [{ url: "http://127.0.0.1:19001", path: "/v1/playback/cancel-session", body: { sessionId: "assistant.one" } }]);
  assert.equal(status.current, "other");
  assert.equal(status.jobs[0]?.sessionId, "other-session");
});

test("invalid scope never falls back to stop all", async () => {
  const f = fixture();
  for (const sessionId of [undefined, null, "", " ", " padded", "a\n", "x".repeat(201), 12]) {
    await assert.rejects(f.control.cancelPlaybackSession({ sessionId } as any), /playback session id/);
  }
  assert.deepEqual(f.calls, []);
});

test("authority is checked before dispatch and after original asynchronous cancellation", async () => {
  const f = fixture();
  const denial = new Error("owner changed");
  await assert.rejects(f.control.cancelPlaybackSession({ sessionId: "assistant.one" }, () => { throw denial; }), error => error === denial);
  assert.equal(f.calls.length, 0);
  let current = true;
  f.defer();
  const result = f.control.cancelPlaybackSession({ sessionId: "assistant.two" }, () => { if (!current) throw denial; });
  current = false;
  f.release();
  await assert.rejects(result, error => error === denial);
  assert.equal(f.calls.length, 1);
});
