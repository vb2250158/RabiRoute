import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./index.mjs", import.meta.url));

async function start(t, patch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-remote-port-fixture-"));
  const child = spawn(process.execPath, [entry], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, REMOTE_AGENT_CONTROL_HOST: "127.0.0.1", REMOTE_AGENT_CONTROL_PORT: "0",
    REMOTE_AGENT_DISCOVERY_PORT_START: "0", REMOTE_AGENT_DISCOVERY_PORT_END: "0",
    REMOTE_AGENT_PASSWORD: "fixture-password-remote-port", REMOTE_AGENT_DEVICE_ID: `fixture-${randomUUID()}`,
    REMOTE_AGENT_DEFAULT_CWD: root, REMOTE_AGENT_FILE_DIR: path.join(root, "files"), REMOTE_AGENT_ALLOWED_CWDS: root,
    REMOTE_AGENT_PUBLIC_CONTROL_URL: "", REMOTE_AGENT_PUBLIC_HOST: "", ...patch
  } });
  let exited = false;
  const exit = once(child, "exit").then(result => { exited = true; return result; });
  t.after(async () => {
    if (!exited) child.kill();
    await exit;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    let buffer = "", controlPort, discoveryPort;
    const timer = setTimeout(() => reject(new Error("Owned Remote Agent fixture did not publish its endpoints.")), 8000);
    const read = bytes => {
      buffer += bytes.toString("utf8");
      for (const line of buffer.split(/\r?\n/)) {
        const tcp = line.match(/Remote Agent control listening on http:\/\/[^\s]+:(\d+)/);
        const udp = line.match(/Remote Agent discovery listening on udp:\/\/0\.0\.0\.0:(\d+)/);
        if (tcp) controlPort = Number(tcp[1]);
        if (udp) discoveryPort = Number(udp[1]);
      }
      if (controlPort && discoveryPort) { clearTimeout(timer); resolve({ controlPort, discoveryPort }); }
    };
    child.stdout.on("data", read); child.stderr.on("data", read);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Owned Remote Agent fixture exited before READY.")); });
  });
  return { child, ...ready };
}

function health(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/health", agent: false }, response => {
      const bytes = []; response.on("data", chunk => bytes.push(chunk));
      response.once("end", () => { try { resolve(JSON.parse(Buffer.concat(bytes).toString("utf8"))); } catch (error) { reject(error); } });
      response.once("error", reject);
    });
    request.once("error", reject); request.setTimeout(2000, () => request.destroy(new Error("Fixture health timeout")));
  });
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("default control uses distinct actual ports while an existing 8797 listener stays untouched", async t => {
  const blocker = http.createServer((_request, response) => response.end('{"marker":"original"}'));
  let ownsBlocker = false;
  try {
    await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.listen(8797, "127.0.0.1", resolve); });
    ownsBlocker = true;
  } catch (error) { if (error.code !== "EADDRINUSE") throw error; }
  if (ownsBlocker) t.after(() => closeServer(blocker));
  const one = await start(t, { REMOTE_AGENT_CONTROL_PORT: undefined });
  const two = await start(t);
  assert.notEqual(one.controlPort, two.controlPort);
  for (const current of [one, two]) {
    assert.ok(current.controlPort > 0); assert.notEqual(current.controlPort, 8797);
    const state = await health(current.controlPort);
    assert.equal(state.controlPort, current.controlPort);
    assert.equal(state.discoveryPort, current.discoveryPort);
    assert.ok(state.discoveryPort > 0);
  }
  if (ownsBlocker) assert.equal((await health(8797)).marker, "original");
});

test("an explicit nonzero starting port keeps its existing conflict scan contract", async t => {
  const blocker = http.createServer((_request, response) => response.end('{"marker":"original"}'));
  await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(blocker));
  const port = blocker.address().port;
  const current = await start(t, { REMOTE_AGENT_CONTROL_PORT: String(port) });
  assert.ok(current.controlPort > port);
  assert.equal((await health(current.controlPort)).controlPort, current.controlPort);
  assert.equal((await health(port)).marker, "original");
});

test("UDP zero publishes its actual address and a client reads that listener's actual control port", async t => {
  const current = await start(t);
  const socket = dgram.createSocket("udp4");
  const closed = new Promise(resolve => socket.once("close", resolve));
  t.after(async () => { socket.close(); await closed; });
  await new Promise(resolve => socket.bind(0, "127.0.0.1", resolve));
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No fixture discovery response")), 2000);
    socket.once("message", (bytes, source) => { clearTimeout(timer); resolve({ data: JSON.parse(bytes.toString()), source }); });
  });
  socket.send(Buffer.from(JSON.stringify({ type: "rabiroute.remoteAgent.client.discover" })), current.discoveryPort, "127.0.0.1");
  const received = await response;
  assert.equal(received.source.port, current.discoveryPort);
  assert.equal(received.data.port, current.controlPort);
  assert.ok(received.data.controlUrl.includes(`:${current.controlPort}/api/remote-agent/control`));
});

test("a configured UDP discovery window skips an occupied socket and preserves its owner", async t => {
  const blocker = dgram.createSocket("udp4");
  const closed = new Promise(resolve => blocker.once("close", resolve));
  t.after(async () => { blocker.close(); await closed; });
  await new Promise(resolve => blocker.bind(0, "0.0.0.0", resolve));
  const port = blocker.address().port;
  if (port === 65535) { t.skip("Ephemeral port has no following candidate"); return; }
  const end = Math.min(port + 5, 65535);
  const current = await start(t, { REMOTE_AGENT_DISCOVERY_PORT_START: String(port), REMOTE_AGENT_DISCOVERY_PORT_END: String(end) });
  assert.ok(current.discoveryPort > port && current.discoveryPort <= end);
  assert.equal(blocker.address().port, port);
  assert.equal((await health(current.controlPort)).discoveryPort, current.discoveryPort);
});
