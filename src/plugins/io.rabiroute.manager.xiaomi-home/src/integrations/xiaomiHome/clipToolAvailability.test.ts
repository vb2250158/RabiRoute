import assert from "node:assert/strict";
import { test } from "node:test";
import { ClipToolAvailability, probeFfmpeg } from "./clipToolAvailability.js";

test("caches a successful check and shares an in-flight check", async () => {
  let calls = 0;
  let finish!: (available: boolean) => void;
  const availability = new ClipToolAvailability("ffmpeg", { probe: async () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }});
  const first = availability.start();
  const second = availability.start();
  assert.equal(availability.status(), "checking");
  finish(true);
  await Promise.all([first, second]);
  assert.equal(availability.status(), "ready");
  await availability.start();
  assert.equal(calls, 1);
  await availability.close();
  assert.equal(availability.status(), "stopped");
});

test("missing executable is unavailable; a later explicit check can recover", async () => {
  assert.equal(await probeFfmpeg("rabiroute-nonexistent-ffmpeg-9375", new AbortController().signal, 1000), false);
  let calls = 0;
  const availability = new ClipToolAvailability("ffmpeg", { attempts: 2, retryDelayMs: 1, probe: async () => ++calls === 3 });
  await availability.start();
  assert.equal(availability.status(), "unavailable");
  assert.equal(calls, 2);
  await availability.start();
  assert.equal(availability.status(), "ready");
  assert.equal(calls, 3);
  await availability.close();
});

test("closing cancels an in-flight probe and does not publish ready", async () => {
  const availability = new ClipToolAvailability("ffmpeg", { probe: async (_exe, signal) => new Promise(resolve => {
    signal.addEventListener("abort", () => resolve(true), { once: true });
  }) });
  const checking = availability.start();
  await availability.close();
  await checking;
  assert.equal(availability.status(), "stopped");
  await availability.start();
  assert.equal(availability.status(), "stopped");
});

test("closing interrupts retry delay", async () => {
  let calls = 0;
  const availability = new ClipToolAvailability("ffmpeg", { retryDelayMs: 30000, probe: async () => { calls++; return false; } });
  const checking = availability.start();
  await new Promise(resolve => setImmediate(resolve));
  await availability.close();
  await checking;
  assert.equal(calls, 1);
  assert.equal(availability.status(), "stopped");
});
