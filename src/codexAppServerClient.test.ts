import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexAppServerClient,
  codexAppServerNotificationEnvelopeForTest,
  codexAppServerRequestEnvelopeForTest,
  failClosedCodexServerRequestForTest
} from "./codexAppServerClient.js";

test("app-server stdio envelopes omit the WebSocket-era jsonrpc field", () => {
  assert.deepEqual(codexAppServerRequestEnvelopeForTest(7, "thread/read", { threadId: "thread-1" }), {
    id: 7,
    method: "thread/read",
    params: { threadId: "thread-1" }
  });
  assert.deepEqual(codexAppServerNotificationEnvelopeForTest("initialized"), { method: "initialized" });
});

test("concurrent requests wait for initialize and initialized", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-app-server-client-"));
  const mockServer = String.raw`
const readline = require("node:readline");
let ready = false;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => send({ id: message.id, result: { userAgent: "mock" } }), 40);
    return;
  }
  if (message.method === "initialized") {
    ready = true;
    return;
  }
  if (message.id != null) {
    if (!ready) send({ id: message.id, error: { code: -32000, message: "request arrived before initialized" } });
    else send({ id: message.id, result: { method: message.method } });
  }
});`;
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: ["-e", mockServer],
    cwd: process.cwd(),
    dataDir,
    requestTimeoutMs: 2_000
  });

  try {
    const [first, second] = await Promise.all([
      client.request("probe/one", {}),
      client.request("probe/two", {})
    ]);
    assert.deepEqual(first, { method: "probe/one" });
    assert.deepEqual(second, { method: "probe/two" });
  } finally {
    client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unbridged app-server approvals fail closed", () => {
  assert.deepEqual(failClosedCodexServerRequestForTest("item/commandExecution/requestApproval"), { decision: "decline" });
  assert.deepEqual(failClosedCodexServerRequestForTest("item/fileChange/requestApproval"), { decision: "decline" });
  assert.deepEqual(failClosedCodexServerRequestForTest("item/permissions/requestApproval"), {
    permissions: {},
    scope: "turn",
    strictAutoReview: true
  });
  assert.throws(
    () => failClosedCodexServerRequestForTest("item/tool/requestUserInput"),
    /no approved handler/
  );
});

test("explicit app-server overload responses retry with backoff", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-app-server-overload-"));
  const mockServer = String.raw`
const readline = require("node:readline");
let attempts = 0;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(JSON.stringify(message) + "\n"); }
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "initialized") return;
  attempts += 1;
  if (attempts < 3) return send({ id: message.id, error: { code: -32001, message: "Server overloaded" } });
  send({ id: message.id, result: { attempts } });
});`;
  const client = new CodexAppServerClient({
    command: process.execPath,
    commandArgs: ["-e", mockServer],
    cwd: process.cwd(),
    dataDir,
    requestTimeoutMs: 2_000,
    overloadRetryBaseMs: 1
  });

  try {
    assert.deepEqual(await client.request("model/list", {}), { attempts: 3 });
  } finally {
    client.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
