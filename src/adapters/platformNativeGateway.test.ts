import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { GATEWAY_LISTENER_PUBLICATION_PREFIX, type GatewayListenerPublication } from "../runtime/gatewayListenerRuntime.js";

test("production platform adapter defaults publish executing bindings through the Gateway stdout owner", { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-gateway-defaults-"));
  const child = fork(fileURLToPath(new URL("./platformNativeGateway.fixture.mts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NATIVE_TEST_ROOT: root, GATEWAY_ID: "controlled-native-gateway", RABIROUTE_GATEWAY_GENERATION_ID: "controlled-generation" }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let buffer = "", errors = ""; const publications: GatewayListenerPublication[] = []; const changed = new EventEmitter();
  child.stderr!.on("data", data => { errors += data.toString(); });
  child.stdout!.on("data", data => {
    buffer += data.toString(); const lines = buffer.split("\n"); buffer = lines.pop()!;
    for (const line of lines) if (line.startsWith(GATEWAY_LISTENER_PUBLICATION_PREFIX)) {
      publications.push(JSON.parse(line.slice(GATEWAY_LISTENER_PUBLICATION_PREFIX.length))); changed.emit("publication");
    }
  });
  const waitFor = async (predicate: () => boolean) => {
    while (!predicate()) await once(changed, "publication", { signal: AbortSignal.timeout(10_000) });
  };
  const [ready] = await once(child, "message"); assert.equal(ready.kind, "ready");
  await waitFor(() => publications.at(-1)?.listeners.length === 2);
  const publication = publications.at(-1)!;
  assert.equal(publication.gatewayId, "controlled-native-gateway");
  assert.equal(publication.gatewayGenerationId, "controlled-generation"); assert.equal(publication.pid, child.pid);
  assert.ok(publication.revision > 0);
  const feishu = publication.listeners.find(value => value.binding.protocol === "feishu-events-v2")!;
  const napcat = publication.listeners.find(value => value.binding.protocol === "onebot-v11-reverse-websocket")!;
  for (const listener of [feishu, napcat]) {
    assert.equal(listener.active, true); assert.equal(listener.binding.invocation, "discovery-only");
    assert.equal(listener.binding.address.hostname, "127.0.0.1"); assert.equal(listener.operations.length, 1);
    assert.match(listener.operations[0]!.contract.operationId, /^gateway\.[a-f0-9]{16}\.gateway\./);
  }
  assert.equal(feishu.binding.authentication.kind, "native"); assert.equal(napcat.binding.authentication.kind, "none");
  const response = await fetch(`http://127.0.0.1:${feishu.binding.address.port}/fixture-feishu`, { method: "POST",
    body: JSON.stringify({ type: "url_verification", token: "fixture-verification", challenge: "through-default-owner" }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { challenge: "through-default-owner" });
  const socket = new WebSocket(`ws://127.0.0.1:${napcat.binding.address.port}/arbitrary/native/path`); await once(socket, "open");
  t.after(() => socket.terminate());
  const frame = once(child, "message"); socket.send(JSON.stringify({ message_id: "default-owner-frame" }));
  assert.deepEqual((await frame)[0], { kind: "frame", messageId: "default-owner-frame" });
  const closed = once(socket, "close"), exited = once(child, "exit"); child.send("stop");
  await closed; const [code] = await exited; assert.equal(code, 0, errors);
  await waitFor(() => publications.at(-1)?.listeners.length === 0);
  assert.equal(JSON.stringify(publications).includes("fixture-app-secret"), false);
  assert.equal(JSON.stringify(publications).includes("fixture-verification"), false);
});
