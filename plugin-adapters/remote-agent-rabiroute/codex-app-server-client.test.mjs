import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";

function mockAppServer(tempDir, responseSource) {
  const entrypoint = path.join(tempDir, "mock-app-server.cjs");
  fs.writeFileSync(entrypoint, `
const readline = require("node:readline");
let attempts = 0;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "initialized") return;
  attempts += 1;
  ${responseSource}
});
`, "utf8");
  return entrypoint;
}

function clientFor(tempDir, entrypoint, extra = {}) {
  return new CodexAppServerClient({
    cwd: process.cwd(),
    logDir: path.join(tempDir, "logs"),
    version: "test",
    entrypoint,
    requestTimeoutMs: 1000,
    overloadRetryBaseMs: 1,
    ...extra
  });
}

test("explicit -32001 overload responses retry with bounded backoff", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-client-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const entrypoint = mockAppServer(tempDir, `
if (attempts < 3) return send({ id: message.id, error: { code: -32001, message: "overloaded" } });
send({ id: message.id, result: { attempts } });`);
  const client = clientFor(tempDir, entrypoint);
  t.after(() => client.close());
  assert.deepEqual(await client.request("turn/start", {}), { attempts: 3 });
});

test("non-overload mutation errors are not retried", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-client-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const entrypoint = mockAppServer(tempDir, `
if (attempts === 1) return send({ id: message.id, error: { code: -32000, message: "mutation failed" } });
send({ id: message.id, result: { attempts } });`);
  const client = clientFor(tempDir, entrypoint);
  t.after(() => client.close());
  await assert.rejects(() => client.request("turn/start", {}), /mutation failed/);
});

test("overload retry count is bounded", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-client-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const entrypoint = mockAppServer(tempDir, `
send({ id: message.id, error: { code: -32001, message: "overloaded-" + attempts } });`);
  const client = clientFor(tempDir, entrypoint, { overloadRetryLimit: 1 });
  t.after(() => client.close());
  await assert.rejects(() => client.request("turn/start", {}), /overloaded-2/);
});

test("request timeouts are not retried", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-client-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const attemptsPath = path.join(tempDir, "attempts.txt");
  const entrypoint = mockAppServer(tempDir, `
require("node:fs").appendFileSync(${JSON.stringify(attemptsPath)}, "x");`);
  const client = clientFor(tempDir, entrypoint);
  t.after(() => client.close());
  await client.start();
  client.requestTimeoutMs = 20;
  await assert.rejects(() => client.request("turn/start", {}), /timed out/);
  assert.equal(fs.readFileSync(attemptsPath, "utf8"), "x");
});

test("a missing pinned runtime reports the npm install remediation lazily", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-remote-client-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const client = clientFor(tempDir, path.join(tempDir, "missing-codex.js"));
  await assert.rejects(() => client.start(), /Run npm install in the bridge folder/);
});
