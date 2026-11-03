import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachTunnelBroker } from "./lib/rabilink-tunnel-broker.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const timeout = milliseconds => AbortSignal.timeout(milliseconds);
const children = [], peers = new Map(), managers = [];
const { openPeerPacket } = await import(pathToFileURL(path.join(root, "dist/rabiPeerProtocol.js")));
const folder = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-connected-hosts-"));
const report = { mode: "two-built-manager-runtimes-one-computer", platform: process.platform, checks: [], stages: [], relaySignals: [], limitations: [
  "Relay directory/signalling use a loopback fixture; encrypted streams use the production tunnel broker.",
  "This is not physical two-computer, public-network or installed-package acceptance.",
  "The fixture calls the production exported startManager with independently namespaced real OS leases; the product single-user entrypoint guard is unchanged.",
  "Agent delivery uses separate isolated test-owner integration tests; no real Desktop task receives a message."
] };
const applicationToken = randomBytes(32).toString("base64url");

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}
async function port() { const server = net.createServer(); const value = await listen(server); await new Promise(resolve => server.close(resolve)); return value; }
async function json(url, body, milliseconds = 60000) {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", signal: timeout(milliseconds),
    headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.ok(response.ok && value.code !== -1, `${response.status}: ${JSON.stringify(value).slice(0, 1000)}`);
  return value;
}
const relay = http.createServer(async (request, response) => {
  const reply = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  try {
    if (request.headers["x-rabilink-token"] !== applicationToken) return reply(403, { error: "fixture application required" });
    const url = new URL(request.url, "http://fixture");
    if (url.pathname === "/api/rabilink/peers") return reply(200, { peers: [...peers].map(([id]) => ({
      id, name: id, online: true, deviceKind: "pc", capabilities: ["peer-tunnel-v1", "rabilink-application-access-v1"], peerUrls: []
    })) });
    if (url.pathname !== "/api/rabilink/peer/proxy") return reply(404, { error: "not a fixture endpoint" });
    let text = ""; for await (const chunk of request) { text += chunk; if (text.length > 2_000_000) throw new Error("fixture signal too large"); }
    const body = JSON.parse(text), target = peers.get(body.targetDeviceId);
    if (!target) return reply(404, { error: "unknown fixture target" });
    const decoded = openPeerPacket(body.packet, applicationToken);
    // Exercise actual Relay bytes deterministically; no fake business operation runs in this fixture.
    if (decoded.input?.kind === "p2p") { report.relaySignals.push({ target: body.targetDeviceId, kind: "p2p", fixtureRejected: true }); return reply(503, { error: "fixture requires Relay transport" }); }
    const forwarded = await fetch(target.url + "/api/rabilink/peer/receive", { method: "POST", signal: timeout(20000),
      headers: { "content-type": "application/json" }, body: JSON.stringify(body.packet) });
    const packet = await forwarded.json();
    let result; try { result = openPeerPacket(packet, applicationToken); } catch { result = packet; }
    report.relaySignals.push({ target: body.targetDeviceId, capability: decoded.capability, operation: decoded.operation, kind: decoded.input?.kind, status: forwarded.status, ok: result?.ok, error: result?.error });
    reply(forwarded.status, packet);
  } catch (error) { report.relaySignals.push({ error: error.message }); reply(500, { error: error.message }); }
});
const broker = attachTunnelBroker(relay, request => request.headers["x-rabilink-token"] === applicationToken ? "fixture-app" : null);

async function waitForPeerOperations(target) {
  const signal = timeout(90000);
  const stream = await fetch(target.url + "/api/events", { signal, headers: { accept: "text/event-stream" } });
  if (!stream.ok || !stream.body) throw new Error("Manager startup events unavailable: HTTP " + stream.status);
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const response = await fetch(target.url + "/api/rabilink/peer/identity", { signal });
      if (response.ok) {
        const identity = await response.json(); assert.equal(identity.deviceId, target.id);
        report.stages.push({ stage: "peer-operations-ready", device: target.id }); return;
      }
      const error = await response.text();
      if (response.status !== 404) throw new Error("Peer readiness HTTP " + response.status + ": " + error);
      let changed = false;
      while (!changed) {
        const chunk = await reader.read(); if (chunk.done) throw new Error("Manager events ended before Peer publication.");
        buffered += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffered.indexOf("\n\n")) >= 0) {
          const block = buffered.slice(0, end); buffered = buffered.slice(end + 2);
          if (/event: ?plugin_(catalog|reconciliation)_changed/.test(block)) changed = true;
        }
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function startManager(id, relayUrl) {
  const state = path.join(folder, id), managerPort = await port();
  await fs.mkdir(path.join(state, "data"), { recursive: true });
  await fs.writeFile(path.join(state, "data/Config.json"), JSON.stringify({ rabiGuid: randomUUID(), rabiName: id,
    rabiLinkRelay: { enabled: true, url: relayUrl, token: applicationToken, deviceId: id },
    webguiLan: { enabled: false, accessToken: randomBytes(32).toString("base64url") } }));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|HOME)$/i.test(key)));
  const bootstrap = path.join(state, "manager-test-launcher.mjs");
  await fs.writeFile(bootstrap, [
    'import { acquireManagerInstanceLock } from ' + JSON.stringify(pathToFileURL(path.join(root, "dist/managerInstanceLock.js")).href) + ';',
    'import { installManagerRuntimeDiagnostics } from ' + JSON.stringify(pathToFileURL(path.join(root, "dist/managerRuntimeDiagnostics.js")).href) + ';',
    'const diagnostics = installManagerRuntimeDiagnostics({rootDir: process.env.RABIROUTE_STATE_ROOT});',
    'const lease = await acquireManagerInstanceLock({rootDir: process.env.RABIROUTE_MANAGER_INSTANCE_LOCK_DIR, ownershipNamespace: ' + JSON.stringify('isolated-connected-hosts:' + id + ':' + randomUUID()) + '});',
    'process.once("exit", () => { void lease.release(); });',
    'try { const {startManager} = await import(' + JSON.stringify(pathToFileURL(path.join(root, "dist/manager/controlPlaneRoutes.js")).href) + '); await startManager({instanceLock: lease}); }',
    'catch(error) { await lease.release(); diagnostics.record("startup_failure", {error}); console.error(error); process.exit(1); }'
  ].join('\n'));
  const child = spawn(process.execPath, [bootstrap], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...environment,
      NO_PROXY: "127.0.0.1,localhost,::1", GATEWAY_MANAGER_HOST: "127.0.0.1", GATEWAY_MANAGER_PORT: String(managerPort),
      RABIROUTE_PACKAGE_ROOT: root, RABIROUTE_STATE_ROOT: state, RABIROUTE_MANAGER_AUTOSTART: "0",
      RABIROUTE_MANAGER_READ_ONLY: "0", RABIROUTE_MANAGER_ACCEPTANCE_MODE: "1", REMOTE_AGENT_DISCOVERABLE: "0",
      RABIROUTE_MANAGER_INSTANCE_LOCK_DIR: path.join(state, "locks")
    }
  });
  children.push(child);
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${id} startup deadline: ${output.slice(-4000)}`)), 90000);
    const consume = chunk => { output = (output + chunk.toString()).slice(-12000);
      if (output.includes(`gateway-manager listening on http://127.0.0.1:${managerPort}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`${id} exited ${code}: ${output.slice(-4000)}`)); });
  });
  await ready;
  const target = { id, state, url: `http://127.0.0.1:${managerPort}`, pid: child.pid, diagnostic: () => output.replaceAll(applicationToken, "[redacted]") };
  managers.push(target);
  await waitForPeerOperations(target);
  peers.set(id, target);
  const meta = await json(target.url + "/meta");
  assert.equal(meta.health.live, true); assert.equal(meta.rabiLinkRelay.deviceId, id);
  report.stages.push({ stage: "manager-ready", device: id, pid: child.pid, live: meta.health.live, lanEnabled: meta.webguiLan.enabled });
  return target;
}
async function verifyComputer(source, target) {
  const prefix = source.url + `/api/rabilink/peer/http/${encodeURIComponent(target.id)}/manager`;
  report.stages.push({ stage: "peer-meta", source: source.id, target: target.id });
  const remoteMeta = await json(prefix + "/meta");
  assert.equal(remoteMeta.managerRuntime.pid, target.pid);
  assert.equal(remoteMeta.rabiLinkRelay.deviceId, target.id);
  const instances = await json(prefix + "/api/lan-agent/instances");
  const local = instances.instances.find(instance => instance.local);
  assert.ok(local?.connected && local.terminalShells.length && local.computerCapabilities.includes("files"));
  const base = prefix + `/api/lan-agent/instances/${encodeURIComponent(local.instanceId)}`;
  const terminalId = randomUUID(), marker = "connected-host-" + randomUUID();
  const shell = process.platform === "win32" ? "cmd" : local.terminalShells.find(value => ["bash", "sh", "zsh"].includes(value));
  const terminal = async body => (await json(base + "/terminals", body)).data;
  const computer = async body => (await json(base + "/computer", body)).data;
  try {
    await terminal({ action: "open", terminalId, shell, cwd: target.state });
    await terminal({ action: "input", terminalId, sequence: 1, data: `"${process.execPath}" -e "process.stdout.write(Buffer.from('${Buffer.from(marker).toString("hex")}','hex'))"\r` });
    let after = 0, output = "";
    for (let attempt = 0; attempt < 12 && !output.includes(marker); attempt++) {
      const result = (await json(base + `/terminals/${terminalId}?after=${after}&waitMs=5000`)).data;
      output += result.outputEvents.map(event => event.data || "").join(""); after = result.nextOutputSequence;
    }
    assert.ok(output.includes(marker), "real remote shell output");
    report.checks.push({ source: source.id, target: target.id, action: "terminal", shell, passed: true });
  } finally { await terminal({ action: "close", terminalId }); }
  const bytes = randomBytes(131077), sha256 = hash(bytes), uploadId = randomUUID(), file = path.join(target.state, `transfer-${uploadId}.bin`);
  await computer({ action: "upload.begin", uploadId, path: file, size: bytes.length, sha256 });
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    const chunk = bytes.subarray(offset, offset + 65536);
    await computer({ action: "upload.write", uploadId, offset, data: chunk.toString("base64"), sha256: hash(chunk) });
  }
  await computer({ action: "upload.commit", uploadId });
  const stat = await computer({ action: "file.stat", path: file });
  const chunks = []; let offset = 0;
  while (offset < stat.size) { const item = await computer({ action: "file.read", path: file, version: stat.version, offset });
    const chunk = Buffer.from(item.data, "base64"); assert.equal(hash(chunk), item.sha256);
    assert.ok(item.nextOffset > offset && item.nextOffset <= stat.size, "download progress follows the original file");
    chunks.push(chunk); offset = item.nextOffset; }
  assert.deepEqual(Buffer.concat(chunks), bytes); assert.deepEqual(await fs.readFile(file), bytes);
  report.checks.push({ source: source.id, target: target.id, action: "files", bytes: bytes.length, passed: true });
  if (process.platform === "win32") {
    const capture = await computer({ action: "screen.capture", maxWidth: 320 });
    assert.equal(capture.mimeType, "image/png"); assert.ok(capture.width > 0 && capture.height > 0);
    assert.equal(Buffer.from(capture.data, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    report.checks.push({ source: source.id, target: target.id, action: "screenshot", width: capture.width, height: capture.height, passed: true });
  }
  const directory = await json(source.url + "/api/rabilink/peer/servers");
  const peer = directory.peers.find(item => item.deviceId === target.id);
  assert.equal(peer.state, "connected"); assert.equal(peer.transport, "relay");
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill();
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 10000);
  try { await exited; } finally { clearTimeout(timer); }
}
let failure;
try {
  const relayPort = await listen(relay), relayUrl = `http://127.0.0.1:${relayPort}`;
  const a = await startManager("fixture-host-a", relayUrl), b = await startManager("fixture-host-b", relayUrl);
  await verifyComputer(a, b); await verifyComputer(b, a);
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; failure = error;
  report.managerDiagnostics = [];
  for (const target of managers) {
    let connections; try { connections = await json(target.url + "/api/rabilink/peer/servers", undefined, 5000); } catch (cause) { connections = { error: cause.message }; }
    report.managerDiagnostics.push({ device: target.id, output: target.diagnostic(), connections });
  }
  report.stateDirectory = folder;
}
finally {
  await Promise.all(children.map(stopChild)); broker.close(); relay.closeAllConnections();
  await new Promise(resolve => relay.close(resolve));
  if (!failure) await fs.rm(folder, { recursive: true, force: true });
  report.managerProcessesExited = children.every(child => child.exitCode !== null || child.signalCode !== null);
  const output = process.argv[2];
  if (output) await fs.writeFile(path.resolve(output), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
if (failure) process.exitCode = 1;
