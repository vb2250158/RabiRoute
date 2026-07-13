import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const relayScript = path.join(repoRoot, "scripts", "rabilink-relay-server.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-device-status-"));
const token = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const appId = "app-device-status-smoke";
const port = 19000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const appStorePath = path.join(tempDir, "apps.json");
const statusPath = path.join(tempDir, "mobile-device-status", `${appId}.json`);

fs.writeFileSync(appStorePath, JSON.stringify({
  accounts: [],
  apps: [{
    id: appId,
    name: "Device status smoke",
    ownerAccountId: "account-smoke",
    enabled: true,
    token,
    targetDeviceId: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }],
  workers: []
}, null, 2));

let relay = null;

function startRelay() {
  relay = spawn(process.execPath, [relayScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: tempDir,
      RABILINK_RELAY_APP_STORE_FILE: appStorePath,
      RABILINK_RELAY_MOBILE_DEVICE_STATUS_STALE_MS: "60000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function stopRelay() {
  if (!relay || relay.exitCode !== null) return;
  const exited = new Promise((resolve) => relay.once("exit", resolve));
  relay.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  relay = null;
}

async function waitForRelay() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (relay?.exitCode !== null) throw new Error(`Relay exited with code ${relay?.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Relay is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Relay did not become ready.");
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      accept: "application/json",
      ...(options.authorized === false ? {} : { "X-RabiLink-Token": token }),
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json();
  return { response, body };
}

try {
  startRelay();
  await waitForRelay();

  const unauthorized = await request("/api/rabilink/mobile/device-status", {
    method: "POST",
    authorized: false,
    body: { batteryLevel: 73, charging: true }
  });
  assert.equal(unauthorized.response.status, 401);

  const invalid = await request("/api/rabilink/mobile/device-status", {
    method: "POST",
    body: { batteryLevel: 101, charging: true }
  });
  assert.equal(invalid.response.status, 400);

  const updated = await request("/api/rabilink/mobile/device-status", {
    method: "POST",
    body: { batteryLevel: 73.4, charging: true, observedAt: new Date().toISOString() }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.deviceStatus.batteryLevel, 73);
  assert.equal(updated.body.deviceStatus.charging, true);
  assert.equal(updated.body.deviceStatus.source, "rokid-cxr-phone");
  assert.equal(updated.body.deviceStatus.stale, false);
  assert.equal(JSON.stringify(updated.body).includes(token), false);

  const liveState = await request("/api/rabilink/mobile/state");
  assert.equal(liveState.body.deviceStatus.batteryLevel, 73);
  assert.equal(liveState.body.deviceStatus.charging, true);
  assert.equal(liveState.body.deviceStatus.stale, false);

  await stopRelay();
  const stored = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  stored.receivedAt = new Date(Date.now() - 120000).toISOString();
  fs.writeFileSync(statusPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

  startRelay();
  await waitForRelay();
  const staleState = await request("/api/rabilink/mobile/state");
  assert.equal(staleState.body.deviceStatus.batteryLevel, 73);
  assert.equal(staleState.body.deviceStatus.stale, true);
  assert.ok(staleState.body.deviceStatus.ageMs >= 120000);

  console.log("RabiLink Relay device-status smoke passed: auth, validation, persistence and staleness.");
} finally {
  await stopRelay();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
