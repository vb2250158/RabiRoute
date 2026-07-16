import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`relay exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("relay did not become healthy");
}

test("relay accepts authenticated glasses log batches and exposes account-scoped queries", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-device-logs-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, "missing-webgui")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForHealth(baseUrl, child);
    const accountResponse = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "device-log-test", password: "strong-test-password" })
    });
    assert.equal(accountResponse.status, 200);
    const cookie = String(accountResponse.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie);

    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Test Glass" })
    });
    assert.equal(appResponse.status, 200);
    const appBody = await appResponse.json();
    assert.ok(appBody.app.token);

    const ingestResponse = await fetch(`${baseUrl}/api/rabilink/devices/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rabilink-token": appBody.app.token
      },
      body: JSON.stringify({
        deviceId: "glass-test-01",
        deviceKind: "glasses",
        source: "rabilink-aiui",
        appVersion: "1.0.17",
        sessionId: "session-test",
        logs: [{
          id: "client-log-1",
          level: "error",
          event: "configuration.model.failed",
          message: "request failed with token=private-value"
        }]
      })
    });
    assert.equal(ingestResponse.status, 202);
    assert.equal((await ingestResponse.json()).accepted, 1);

    const queryResponse = await fetch(`${baseUrl}/manage/api/device-logs?deviceId=glass-test-01&level=error`, {
      headers: { cookie }
    });
    assert.equal(queryResponse.status, 200);
    const queryBody = await queryResponse.json();
    assert.equal(queryBody.logs.length, 1);
    assert.equal(queryBody.logs[0].message, "request failed with token=[redacted]");
    assert.deepEqual(queryBody.facets.devices, ["glass-test-01"]);

    const unauthorized = await fetch(`${baseUrl}/api/rabilink/devices/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: [{ message: "must fail" }] })
    });
    assert.equal(unauthorized.status, 401);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});
