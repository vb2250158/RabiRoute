import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { NativeComputerClient } from "../lib/computer-native-client.mjs";

function childFixture(onWrite) {
  const child = new EventEmitter(); child.pid = 1; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) { onWrite?.(String(chunk), child); done(); } });
  child.stdin.once("finish", () => setImmediate(() => child.emit("close", 0)));
  return child;
}

test("native correlation ID and action cannot be overwritten by request body fields", async () => {
  let sent;
  const child = childFixture((line, current) => {
    sent = JSON.parse(line);
    setImmediate(() => current.stdout.write(JSON.stringify({ id: sent.id, result: { state: "observed" } }) + "\n"));
  });
  const client = new NativeComputerClient({ launch: () => child });
  assert.equal((await client.request("capabilities", { id: "caller-id", action: "input.execute" })).state, "observed");
  assert.notEqual(sent.id, "caller-id"); assert.equal(sent.action, "capabilities");
  await client.close();
});

test("native process startup failure rejects the pending call immediately and closes its Qt owner", async () => {
  const child = childFixture(); child.pid = undefined;
  const client = new NativeComputerClient({ launch: () => { setImmediate(() => child.emit("error", new Error("fixture executable absent"))); return child; }, timeout: () => 1000 });
  const started = performance.now();
  await assert.rejects(client.request("capabilities"), error => error.code === "COMPUTER_NATIVE_START_FAILED" && !error.uncertain);
  assert.ok(performance.now() - started < 500);
  await client.close();
  let closed = 0;
  const noNative = new NativeComputerClient();
  noNative.qt = { close: async () => { closed++; } };
  await noNative.close(); assert.equal(closed, 1);
});

test("native responses can arrive out of order while a slow capture is pending", async () => {
  const pending = [];
  const child = childFixture(line => pending.push(JSON.parse(line)));
  const client = new NativeComputerClient({ launch: () => child });
  const capture = client.request("screen.capture");
  const ending = client.request("control.end", { controlSessionId: "original" });
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(JSON.stringify({ id: pending[1].id, result: { state: "ended" } }) + "\n");
  assert.equal((await ending).state, "ended");
  child.stdout.write(JSON.stringify({ id: pending[0].id, result: { frameId: "old-observation" } }) + "\n");
  assert.equal((await capture).frameId, "old-observation");
  await client.close();
});

test("a control intent cancelled during Qt startup never reaches the native command pipe", async () => {
  let ready, sends = 0, cancelled = false;
  const client = new NativeComputerClient({ launch: () => { sends++; return childFixture(); } });
  client.qt = { start: () => new Promise(resolve => { ready = resolve; }), close: async () => {} };
  const pending = client.request("control.begin", { controlSessionId: "old" }, { beforeSend: () => { if (cancelled) throw Object.assign(new Error("Original owner ended"), { code: "COMPUTER_SOURCE_CLOSED" }); } });
  cancelled = true; ready();
  await assert.rejects(pending, error => error.code === "COMPUTER_SOURCE_CLOSED");
  assert.equal(sends, 0);
  await client.close();
});

test("chunked screenshot frames and a following control reply keep their original boundaries", async () => {
  const data = "a".repeat(1024 * 1024);
  const child = childFixture((line, current) => {
    const request = JSON.parse(line);
    const response = JSON.stringify({ id: request.id, result: { frameId: "fixture-frame", data } }) + "\n";
    setImmediate(() => { for (let offset = 0; offset < response.length; offset += 4096) current.stdout.write(response.slice(offset, offset + 4096)); });
  });
  const client = new NativeComputerClient({ launch: () => child });
  const result = await client.request("screen.capture");
  assert.equal(result.frameId, "fixture-frame"); assert.equal(result.data.length, data.length);
  await client.close();
});
