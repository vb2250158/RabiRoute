import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindFetchCompatible, fetchPortBlocked } from "./bridge-endpoint.mjs";

test("dynamic listeners reject Fetch-blocked ports with bounded retry", async t => {
  assert.equal(await fetchPortBlocked("http://127.0.0.1:6000"), true);
  const server = http.createServer((_request, response) => response.end("ok"));
  let attempts = 0;
  const url = await bindFetchCompatible(server, "127.0.0.1", 0, async address => { attempts++; return attempts === 1 || fetchPortBlocked(address); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(attempts, 2);
  assert.equal(await fetchPortBlocked(url), false);
  let rejected = 0;
  const exhausted = http.createServer();
  await assert.rejects(bindFetchCompatible(exhausted, "127.0.0.1", 0, async () => { rejected++; return true; }), /accepted by Fetch/);
  assert.equal(rejected, 16);
  const configured = http.createServer();
  await assert.rejects(bindFetchCompatible(configured, "127.0.0.1", 0, async () => { throw new Error("probe failed"); }), /probe failed/);
  assert.equal(configured.listening, false);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const explicitPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const explicit = http.createServer();
  let explicitChecks = 0;
  await assert.rejects(bindFetchCompatible(explicit, "127.0.0.1", explicitPort, async () => { explicitChecks++; return true; }), /configured XiaoAI bridge port/);
  assert.equal(explicitChecks, 1);
  assert.equal(explicit.listening, false);
});

test("bridge chooses a free port and smoke discovers its verified live endpoint", { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoai-bridge-test-"));
  const endpointDirectory = path.join(root, "endpoints");
  fs.mkdirSync(endpointDirectory);
  fs.writeFileSync(path.join(endpointDirectory, "foreign.json"), "do-not-overwrite");
  const occupied = net.createServer();
  const ownsOldPort = await new Promise((resolve, reject) => {
    occupied.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
    occupied.listen(8798, "127.0.0.1", () => resolve(true));
  });
  let redirect = false, redirected = 0;
  const webhook = http.createServer((request, response) => { request.resume(); request.on("end", () => {
    if (request.url?.startsWith("/other")) redirected++;
    if (redirect && request.url?.startsWith("/webhook")) { response.writeHead(302, { location: "/other" }); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
  }); });
  webhook.listen(0, "127.0.0.1");
  await once(webhook, "listening");
  const env = { ...process.env, XIAOAI_BRIDGE_ENDPOINT_DIRECTORY: endpointDirectory, XIAOAI_BRIDGE_HOST: "127.0.0.1", XIAOAI_BRIDGE_PORT: "0", RABIROUTE_WEBHOOK_URL: `http://127.0.0.1:${webhook.address().port}/webhook?token=fixture-secret` };
  delete env.XIAOAI_BRIDGE_URL;
  const bridge = spawn(process.execPath, ["index.mjs"], { cwd: new URL(".", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { bridge.kill(); webhook.close(); if (ownsOldPort) occupied.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let output = "";
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.once("exit", code => reject(new Error(`Bridge exited before ready: ${code}`)));
    bridge.stdout.on("data", chunk => { output += chunk; if (output.includes("XiaoAI RabiRoute adapter listening")) resolve(); });
  });
  const endpointFile = path.join(endpointDirectory, fs.readdirSync(endpointDirectory).find(name => name !== "foreign.json"));
  const record = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
  assert.equal(fs.readFileSync(path.join(endpointDirectory, "foreign.json"), "utf8"), "do-not-overwrite");
  assert.notEqual(new URL(record.address).port, "8798");
  const health = await (await fetch(`${record.address}/health`)).text();
  assert.doesNotMatch(health, /fixture-secret|rabiRouteWebhookUrl/);
  assert.doesNotMatch(output, /fixture-secret/);
  await fetch(`${record.address}/v1/xiaoai/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "private-speech-fixture" }) });
  assert.doesNotMatch(await (await fetch(`${record.address}/health`)).text(), /private-speech-fixture/);
  const smoke = spawn(process.execPath, ["smoke-send.mjs"], { cwd: new URL(".", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  let result = "";
  smoke.stdout.on("data", chunk => { result += chunk; });
  assert.equal((await once(smoke, "exit"))[0], 0);
  assert.match(result, /^200 /);
  redirect = true;
  const rejected = await fetch(`${record.address}/v1/xiaoai/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "fixture" }) });
  assert.equal(rejected.status, 500);
  assert.equal(redirected, 0);
  const second = spawn(process.execPath, ["index.mjs"], { cwd: new URL(".", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => second.kill());
  await new Promise((resolve, reject) => {
    let text = "";
    second.once("error", reject);
    second.once("exit", code => reject(new Error(`Second bridge exited before ready: ${code}`)));
    second.stdout.on("data", chunk => { text += chunk; if (text.includes("XiaoAI RabiRoute adapter listening")) resolve(); });
  });
  const ambiguous = spawn(process.execPath, ["smoke-send.mjs"], { cwd: new URL(".", import.meta.url), env, stdio: "ignore" });
  assert.notEqual((await once(ambiguous, "exit"))[0], 0);
  second.kill();
  await once(second, "exit");
  fs.writeFileSync(endpointFile, JSON.stringify({ ...record, instanceId: "00000000-0000-0000-0000-000000000000" }));
  const stale = spawn(process.execPath, ["smoke-send.mjs"], { cwd: new URL(".", import.meta.url), env, stdio: "ignore" });
  assert.notEqual((await once(stale, "exit"))[0], 0);
});
