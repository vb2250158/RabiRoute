import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SpeechRuntimeControl } from "./speechRuntimeControl.js";
import type { SpeechRuntimeStatus } from "@rabiroute/host-api/shared/speechControlContract";

function fixture(options: { nonceValid?: boolean; ownerMatches?: boolean; publish?: boolean; retire?: boolean } = {}) {
  let clock = 0, launches = 0, probes = 0, killed = 0, nonce = "";
  const child = { pid: 123, exitCode: null as number | null, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} };
  const record = () => ({ schemaVersion: 1, nonce: options.nonceValid === false ? "stale-nonce" : nonce, pid: 456, host: "127.0.0.1", port: 31415 });
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", managedEndpoint: () => true,
    serviceUrl: () => "", existsSync: () => true,
    startTimeoutMs: 500, stopTimeoutMs: 500, now: () => clock,
    wait: async ms => { clock += ms; await new Promise(resolve => setImmediate(resolve)); },
    inspectOwner: async port => { assert.equal(port, 31415); return child.exitCode !== null ? null : { pid: options.ownerMatches === false ? 999 : 456, owned: true }; },
    inspect: async url => { probes++; assert.equal(url, "http://127.0.0.1:31415"); return { state: "online", checkedAt: "fixture", configuredUrl: url, service: "RabiSpeech", defaults: {}, providers: { tts: [], asr: [] } } satisfies SpeechRuntimeStatus; },
    spawnRuntime: (_command, _args, launch) => {
      launches++; nonce = String(launch!.env!.RABISPEECH_ENDPOINT_NONCE);
      assert.equal(launch!.env!.RABISPEECH_PORT, "0"); assert.equal(launch!.env!.RABISPEECH_HOST, "127.0.0.1"); assert.equal(launch!.detached, false);
      if (options.publish !== false) queueMicrotask(() => {
        const line = "RABISPEECH_READY:" + JSON.stringify(record()) + "\n";
        child.stdout.write(line.slice(0, 12)); child.stdout.write(line.slice(12));
      });
      return child;
    },
    killProcessTree: async pid => { assert.equal(pid, 123, "only the launched tree may be terminated"); killed++; if (options.retire !== false) child.exitCode = 0; }
  });
  return { control, child, record, counts: () => ({ launches, probes, killed }) };
}

test("managed Speech publishes only its verified actual descendant endpoint and coalesces starts", async () => {
  const f = fixture(); assert.throws(() => f.control.serviceUrl(), /尚未发布/);
  await Promise.all([f.control.start(), f.control.start()]);
  assert.equal(f.control.serviceUrl(), "http://127.0.0.1:31415");
  assert.equal(f.counts().launches, 1);
  await f.control.releaseOwnedRuntime();
  assert.equal(f.child.exitCode, 0); assert.throws(() => f.control.serviceUrl(), /尚未发布/);
});

test("wrong nonce or process ownership never becomes a managed endpoint", async () => {
  for (const options of [{ nonceValid: false }, { ownerMatches: false }]) {
    const f = fixture(options);
    await assert.rejects(f.control.start());
    assert.equal(f.counts().probes, 0); assert.equal(f.child.exitCode, 0);
    assert.throws(() => f.control.serviceUrl());
  }
});

test("retirement cancels a pending managed handshake and joins the launched process", async () => {
  const f = fixture({ publish: false });
  const starting = f.control.start();
  const rejected = assert.rejects(starting, /取消|配置已变化/);
  await new Promise(resolve => setImmediate(resolve));
  await f.control.releaseOwnedRuntime(); await rejected;
  assert.equal(f.child.exitCode, 0); assert.equal(f.counts().killed, 1);
  assert.throws(() => f.control.serviceUrl());
});

test("unconfirmed process retirement retains its owner for a later release", async () => {
  const f = fixture({ retire: false }); await f.control.start();
  await assert.rejects(f.control.releaseOwnedRuntime(), /无法确认/);
  assert.equal(f.child.exitCode, null); assert.throws(() => f.control.serviceUrl());
  f.child.exitCode = 0; await f.control.releaseOwnedRuntime();
});

test("configured Speech URLs remain explicit and never require a managed handshake", () => {
  const control = new SpeechRuntimeControl({ rootDir: "fixture", serviceUrl: () => "https://speech.example.test:9443", managedEndpoint: () => false });
  assert.equal(control.serviceUrl(), "https://speech.example.test:9443");
});

test("an unstarted managed owner with no raw URL can stop and release without probing a fixed address", async () => {
  const f = fixture();
  assert.equal((await f.control.stop()).action, "already_offline");
  await f.control.releaseOwnedRuntime();
  assert.deepEqual(f.counts(), { launches: 0, probes: 0, killed: 0 });
});

test("configured URL changes release the original child and bind before launching the next configured target", async () => {
  let url = "http://127.0.0.1:31415";
  const children: Array<{ pid: number; exitCode: number | null; port: number; unref(): void }> = [];
  const actions: string[] = [];
  const control = new SpeechRuntimeControl({
    rootDir: "C:/RabiRoute", platform: "win32", managedEndpoint: () => false, serviceUrl: () => url, existsSync: () => true,
    inspect: async value => ({ state: children.some(child => child.exitCode === null && child.port === Number(new URL(value).port)) ? "online" : "offline", checkedAt: "fixture", configuredUrl: value, defaults: {}, providers: { tts: [], asr: [] } }),
    spawnRuntime: (_command, _args, options) => {
      const port = Number(options!.env!.RABISPEECH_PORT);
      assert.equal(options!.env!.RABISPEECH_HOST, "127.0.0.1");
      actions.push("start:" + port);
      const child = { pid: children.length + 100, exitCode: null, port, unref() {} }; children.push(child); return child;
    },
    inspectOwner: async port => { const child = children.find(child => child.port === port && child.exitCode === null); return child ? { pid: child.pid, owned: true } : null; },
    killProcessTree: async pid => { const child = children.find(child => child.pid === pid)!; actions.push("stop:" + child.port); child.exitCode = 0; }
  });
  await control.start();
  url = "http://127.0.0.1:31416"; await control.reconfigure();
  assert.deepEqual(actions, ["start:31415", "stop:31415", "start:31416"]);
  assert.equal(children[0].exitCode, 0); assert.equal(children[1].exitCode, null);
  await control.releaseOwnedRuntime(); assert.equal(children[1].exitCode, 0);
});

test("remote configured changes query the current provider without acquiring or stopping a local runtime", async () => {
  let url = "https://speech-a.example.test";
  const queries: string[] = [];
  const control = new SpeechRuntimeControl({ rootDir: "fixture", serviceUrl: () => url, managedEndpoint: () => false,
    inspect: async address => { queries.push(address); return { state: "offline", checkedAt: "fixture", configuredUrl: address, defaults: {}, providers: { tts: [], asr: [] } }; },
    inspectOwner: async () => { assert.fail("external providers have no local ownership lookup"); },
    spawnRuntime: () => { assert.fail("external providers are not locally launched"); },
    killProcessTree: async () => { assert.fail("external providers are not locally stopped"); }
  });
  const superseded = control.reconfigure(); const rejected = assert.rejects(superseded, /配置已再次变化/);
  url = "https://speech-b.example.test";
  const latest = await control.reconfigure(); await rejected;
  assert.equal(latest.action, "already_offline"); assert.deepEqual(queries, [url]);
});

test("configuration reconciliation never replaces an owner whose process retirement remains unconfirmed", async () => {
  const f = fixture({ retire: false }); await f.control.start();
  await assert.rejects(f.control.reconfigure(), /无法确认/);
  assert.equal(f.counts().launches, 1); assert.equal(f.child.exitCode, null);
  assert.throws(() => f.control.serviceUrl());
  f.child.exitCode = 0; await f.control.releaseOwnedRuntime();
});
