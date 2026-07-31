import assert from "node:assert/strict";
import test from "node:test";
import type { SpeechRuntimeStatus } from "../shared/speechControlContract.js";
import {
  SpeechRuntimeControl,
  SpeechRuntimeControlError
} from "./speechRuntimeControl.js";

function status(state: SpeechRuntimeStatus["state"]): SpeechRuntimeStatus {
  return {
    state,
    checkedAt: "2026-07-30T00:00:00.000Z",
    configuredUrl: "http://127.0.0.1:8781",
    defaults: {},
    providers: { tts: [], asr: [] },
    ...(state === "offline" ? { error: "fetch failed" } : {})
  };
}

const installed = () => true;

test("speech runtime start launches once and waits for real health", async () => {
  const states = [status("offline"), status("offline"), status("online")];
  let launches = 0;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => states.shift() ?? status("online"),
    spawnRuntime: () => {
      launches += 1;
      return { pid: 123, exitCode: null, unref() {} };
    },
    wait: async () => {}
  });

  const result = await control.start();
  assert.equal(result.action, "started");
  assert.equal(result.status.state, "online");
  assert.equal(launches, 1);
});

test("speech runtime start reuses an already healthy service", async () => {
  let launches = 0;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status("online"),
    spawnRuntime: () => {
      launches += 1;
      return { pid: 123, exitCode: null, unref() {} };
    }
  });

  const result = await control.start();
  assert.equal(result.action, "already_online");
  assert.equal(launches, 0);
});

test("speech runtime stop verifies an external port owner before killing", async () => {
  const states = [status("offline")];
  const killed: number[] = [];
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => states.shift() ?? status("offline"),
    inspectOwner: async () => ({ pid: 456, owned: true }),
    killProcessTree: async pid => { killed.push(pid); },
    wait: async () => {}
  });

  const result = await control.stop();
  assert.equal(result.action, "stopped");
  assert.deepEqual(killed, [456]);
});

test("speech runtime stop fails closed for an unrelated port owner", async () => {
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status("online"),
    inspectOwner: async () => ({ pid: 999, owned: false }),
    killProcessTree: async () => { throw new Error("must not kill"); }
  });

  await assert.rejects(
    () => control.stop(),
    (error: unknown) => error instanceof SpeechRuntimeControlError && error.status === 409
  );
});

test("speech runtime control serializes competing transitions", async () => {
  const actions: string[] = [];
  let online = false;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status(online ? "online" : "offline"),
    spawnRuntime: () => {
      actions.push("start");
      online = true;
      return { pid: 123, exitCode: null, unref() {} };
    },
    killProcessTree: async () => {
      actions.push("stop");
      online = false;
    },
    wait: async () => {}
  });

  const start = control.start();
  const stop = control.stop();
  await Promise.all([start, stop]);
  assert.deepEqual(actions, ["start", "stop"]);
});
