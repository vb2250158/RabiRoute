import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(projectRoot, "..", "..");
const relayServerPath = path.join(repoRoot, "scripts", "rabilink-relay-server.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForRelay(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Relay exited early with code ${child.exitCode}.`);
    try {
      const result = await request(`${baseUrl}/health`);
      if (result.response.ok) return;
    } catch {
      // Retry while the child initializes its data directory.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Relay did not become ready.");
}

const tempRoot = path.join(os.tmpdir(), `rabilink-device-enrollment-${process.pid}-${Date.now()}`);
const appStorePath = path.join(tempRoot, "apps.json");
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const username = "device-enrollment";
const password = "test-password";
const serialNumber = "RK-GLASS-SN-2026-0001";
const adminAuth = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
let child;

try {
  child = spawn(process.execPath, [relayServerPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: tempRoot,
      RABILINK_RELAY_APP_STORE_FILE: appStorePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForRelay(baseUrl, child);

  const accountResult = await request(`${baseUrl}/manage/api/accounts`, {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  assert(accountResult.response.status === 200, "Management account creation must succeed.");

  const appResult = await request(`${baseUrl}/manage/api/apps`, {
    method: "POST",
    headers: { "X-RabiLink-Admin-Auth": adminAuth },
    body: JSON.stringify({ name: "RabiLink Glass Enrollment" })
  });
  assert(appResult.response.status === 200 && appResult.body?.app?.id, "Management API must create an app.");
  const appId = appResult.body.app.id;
  const appToken = String(appResult.body.app.token || "");
  assert(appToken, "New app must expose its fixture credential once.");
  await request(`${baseUrl}/worker/tasks?deviceId=pc-tasks&deviceGuid=guid-tasks&waitMs=0&taskFormat=opaque-v1`, {
    headers: {"X-RabiLink-Token": appToken}
  });
  const taskOnly = await request(`${baseUrl}/manage/api/apps/${encodeURIComponent(appId)}/devices`, {
    method:"POST", headers:{"X-RabiLink-Admin-Auth":adminAuth},
    body:JSON.stringify({serialNumber,connectionTargetDeviceId:"pc-tasks"})
  });
  assert(taskOnly.response.status === 409 && (taskOnly.body.code === "DEVICE_CONNECTION_MANAGER_REQUIRED" || taskOnly.body.message === "DEVICE_CONNECTION_MANAGER_REQUIRED"), "A tasks-only PC cannot own glasses Manager configuration: " + JSON.stringify({status:taskOnly.response.status,code:taskOnly.body.code,message:taskOnly.body.message}));
  await request(`${baseUrl}/worker/webgui-requests?deviceId=pc-owner&deviceGuid=guid-owner&capabilities=webgui&waitMs=1`, {
    headers: {"X-RabiLink-Token": appToken}
  });

  const bindingResult = await request(`${baseUrl}/manage/api/apps/${encodeURIComponent(appId)}/devices`, {
    method: "POST",
    headers: { "X-RabiLink-Admin-Auth": adminAuth },
    body: JSON.stringify({ serialNumber, connectionTargetDeviceId:"pc-owner" })
  });
  assert(bindingResult.response.status === 200, "Logged-in management API must bind the glasses SN.");
  assert(bindingResult.body?.device?.claimed === false, "A new binding must wait for first device claim.");
  const ownerBinding = bindingResult.body?.app?.deviceBindings?.find(row => row.id === bindingResult.body?.device?.id);
  assert(ownerBinding?.connectionTargetDeviceId === "pc-owner", "Binding must freeze the explicit Manager-capable owner.");

  const claimResult = await request(`${baseUrl}/api/rabilink/devices/token`, {
    method: "POST",
    body: JSON.stringify({ serialNumber })
  });
  assert(claimResult.response.status === 200, "A pre-bound SN must claim a device credential.");
  const deviceToken = String(claimResult.body?.token || "");
  assert(deviceToken.startsWith("rbd_"), "Relay must issue a dedicated rbd_ device credential.");

  const mobileState = await request(`${baseUrl}/api/rabilink/mobile/state`, {
    headers: { "X-RabiLink-Token": deviceToken }
  });
  assert(mobileState.response.status === 200, "The device credential must authenticate normal Relay APIs.");

  const secondClaim = await request(`${baseUrl}/api/rabilink/devices/token`, {
    method: "POST",
    body: JSON.stringify({ serialNumber })
  });
  assert(secondClaim.response.status === 409, "The same pending SN must not reveal a second credential.");
  assert(secondClaim.body?.code === "DEVICE_ALREADY_CLAIMED", "Second claim must expose a stable recovery code.");

  const stored = fs.readFileSync(appStorePath, "utf8");
  assert(!stored.includes(serialNumber), "The app store must not persist the full glasses SN.");
  assert(!stored.includes(deviceToken), "The app store must not persist the usable device credential.");

  const managementState = await request(`${baseUrl}/manage/api/state`, {
    headers: { "X-RabiLink-Admin-Auth": adminAuth }
  });
  const binding = managementState.body?.apps?.find((app) => app.id === appId)?.deviceBindings?.[0];
  assert(binding?.claimed === true, "Management state must show that the glasses claimed its credential.");
  const changedOwner = await request(`${baseUrl}/manage/api/apps/${encodeURIComponent(appId)}/devices`, {
    method:"POST",headers:{"X-RabiLink-Admin-Auth":adminAuth},body:JSON.stringify({serialNumber,connectionTargetDeviceId:"pc-tasks"})
  });
  assert(changedOwner.response.status === 409 && changedOwner.body.message === "CONNECTION_TARGET_IMMUTABLE", "Credential reset cannot change the original binding owner.");
  const reset = await request(`${baseUrl}/manage/api/apps/${encodeURIComponent(appId)}/devices`, {
    method:"POST",headers:{"X-RabiLink-Admin-Auth":adminAuth},body:JSON.stringify({serialNumber})
  });
  assert(reset.response.status === 200 && reset.body.device.id === binding.id, "Credential reset must preserve the original binding identity.");
  assert(reset.body.app.deviceBindings.find(row=>row.id===binding.id)?.connectionTargetDeviceId === "pc-owner", "Credential reset must preserve the original Manager owner.");

  console.log("RabiLink device enrollment smoke passed.");
} finally {
  if (child && child.exitCode == null) child.kill();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
