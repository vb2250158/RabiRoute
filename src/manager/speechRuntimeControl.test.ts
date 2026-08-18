import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
  let launchCommand = "";
  let launchArgs: string[] = [];
  let detached: boolean | undefined;
  let launchEnv: NodeJS.ProcessEnv | undefined;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => states.shift() ?? status("online"),
    spawnRuntime: (command, args, options) => {
      launches += 1;
      launchCommand = command;
      launchArgs = args;
      detached = options?.detached;
      launchEnv = options?.env;
      return { pid: 123, exitCode: null, unref() {} };
    },
    wait: async () => {}
  });

  const result = await control.start();
  assert.equal(result.action, "started");
  assert.equal(result.status.state, "online");
  assert.equal(launches, 1);
  assert.equal(launchCommand, "powershell.exe");
  assert.equal(detached, false);
  assert.equal(launchEnv?.PYTHONUTF8, "1");
  assert.equal(launchEnv?.PYTHONIOENCODING, "utf-8");
  assert.deepEqual(launchArgs.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
  assert.match(launchArgs.at(-1) || "", /scripts[\\/]start\.ps1$/i);
});

test("speech runtime bind failure reports the port from the launch log", async () => {
  const stderr = new PassThrough();
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status("offline"),
    spawnRuntime: () => {
      queueMicrotask(() => stderr.end(
        "OSError: [WinError 10048] error while attempting to bind on address ('0.0.0.0', 8782)"
      ));
      return { pid: 123, exitCode: 3, stderr, unref() {} };
    },
    inspectOwner: async () => null,
    wait: async () => {}
  });

  await assert.rejects(
    () => control.start(),
    (error: unknown) => {
      assert.ok(error instanceof SpeechRuntimeControlError);
      assert.match(error.detail, /8782/);
      assert.match(error.resolution, /8782/);
      assert.doesNotMatch(error.resolution, /8781/);
      return true;
    }
  );
});

test("speech runtime start replaces a stale owned runtime blocking the remote audio port", async () => {
  const killed: number[] = [];
  let launches = 0;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status(launches >= 2 ? "online" : "offline"),
    spawnRuntime: () => {
      launches += 1;
      if (launches === 1) {
        const stderr = new PassThrough();
        queueMicrotask(() => stderr.end(
          "OSError: [WinError 10048] error while attempting to bind on address ('0.0.0.0', 8782)"
        ));
        return { pid: 123, exitCode: 3, stderr, unref() {} };
      }
      return { pid: 789, exitCode: null, unref() {} };
    },
    inspectOwner: async port => port === 8782 ? { pid: 456, owned: true } : null,
    killProcessTree: async pid => { killed.push(pid); },
    wait: async () => {}
  });

  const result = await control.start();
  assert.equal(result.action, "started");
  assert.equal(result.status.state, "online");
  assert.equal(launches, 2);
  assert.deepEqual(killed, [456]);
});

test("speech runtime default startup budget covers a slow cold source scan", async () => {
  let now = 0;
  let launched = false;
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => status(launched && now >= 60_500 ? "online" : "offline"),
    spawnRuntime: () => {
      launched = true;
      return { pid: 123, exitCode: null, unref() {} };
    },
    wait: async milliseconds => { now += milliseconds; },
    now: () => now
  });

  const result = await control.start();
  assert.equal(result.action, "started");
  assert.equal(result.status.state, "online");
});

test("speech runtime timeout returns the last concrete failure and a recovery action", async () => {
  const offline = status("offline");
  offline.error = "health request timed out after 5000 ms";
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute",
    serviceUrl: () => "http://127.0.0.1:8781",
    platform: "win32",
    existsSync: installed,
    inspect: async () => offline,
    spawnRuntime: () => ({ pid: 123, exitCode: null, unref() {} }),
    wait: async () => {},
    startTimeoutMs: 0
  });

  await assert.rejects(
    () => control.start(),
    (error: unknown) => {
      assert.ok(error instanceof SpeechRuntimeControlError);
      assert.match(error.detail, /health request timed out after 5000 ms/);
      assert.match(error.resolution, /重新启动|启动日志/);
      return true;
    }
  );
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
