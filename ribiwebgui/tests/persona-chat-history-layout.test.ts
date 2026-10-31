import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { waitForChatHistoryFrame } from "../src/personaChatHistoryLayout";

test("a paused layout frame is released on abort, hiding, or completion", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const document = Object.assign(new EventTarget(), { hidden: false });
  let callback: FrameRequestCallback | undefined;
  let cancelled = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (next: FrameRequestCallback) => { callback = next; return 7; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => { assert.equal(id, 7); cancelled++; callback = undefined; } });
  try {
    for (const outcome of ["abort", "hidden", "frame"] as const) {
      document.hidden = false;
      const controller = new AbortController();
      const result = waitForChatHistoryFrame(controller.signal);
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      assert.equal(getEventListeners(document, "visibilitychange").length, 1);
      if (outcome === "abort") controller.abort();
      else if (outcome === "hidden") { document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); }
      else callback!(0);
      assert.equal(await result, outcome === "frame");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(getEventListeners(document, "visibilitychange").length, 0);
      assert.equal(callback, undefined);
    }
    assert.equal(cancelled, 3);
    document.hidden = true;
    assert.equal(await waitForChatHistoryFrame(new AbortController().signal), false);
    document.hidden = false;
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await waitForChatHistoryFrame(aborted.signal), false);
    assert.equal(cancelled, 3);
  } finally {
    for (const [key, descriptor] of [["document", originalDocument], ["requestAnimationFrame", originalRequest], ["cancelAnimationFrame", originalCancel]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
