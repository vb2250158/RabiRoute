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
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`relay exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Relay is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("relay did not become healthy");
}

async function createApp(baseUrl) {
  const account = await fetch(`${baseUrl}/manage/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "mobile-worker-test", password: "strong-test-password" })
  });
  assert.equal(account.status, 200);
  const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];
  const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Mobile worker filtering" })
  });
  assert.equal(appResponse.status, 200);
  return { token: (await appResponse.json()).app.token, cookie };
}

async function subscribe(baseUrl, token, identity) {
  const response = await fetch(`${baseUrl}/api/rabilink/events?${new URLSearchParams(identity)}`, {
    headers: { "x-rabilink-token": token, accept: "text/event-stream" }
  });
  assert.equal(response.status, 200);
  return response;
}

test("mobile PC picker exposes only processing workers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-mobile-workers-"));
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
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const subscriptions = [];
  try {
    await waitForHealth(baseUrl, child);
    const { token, cookie } = await createApp(baseUrl);
    subscriptions.push(await subscribe(baseUrl, token, {
      deviceId: "elysia-pc",
      deviceGuid: "guid-elysia",
      deviceName: "Elysia",
      capabilities: "tasks"
    }));
    subscriptions.push(await subscribe(baseUrl, token, {
      deviceId: "company-pc",
      deviceGuid: "guid-company",
      deviceName: "Company PC",
      capabilities: "webgui,persona-sync,speech"
    }));
    subscriptions.push(await subscribe(baseUrl, token, {
      deviceId: "legacy-pc",
      deviceGuid: "guid-legacy",
      deviceName: "Legacy PC"
    }));
    subscriptions.push(await subscribe(baseUrl, token, {
      deviceId: "rabi-phone",
      deviceName: "Rabi Phone",
      deviceKind: "phone"
    }));
    subscriptions.push(await subscribe(baseUrl, token, {
      deviceId: "rabi-glass",
      deviceName: "Rabi Glass",
      deviceKind: "glasses"
    }));

    const stateResponse = await fetch(`${baseUrl}/api/rabilink/mobile/state`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.deepEqual(state.workers.map(worker => worker.id).sort(), ["company-pc", "elysia-pc", "legacy-pc"]);

    const manageStateResponse = await fetch(`${baseUrl}/manage/api/state`, { headers: { cookie } });
    assert.equal(manageStateResponse.status, 200);
    const manageState = await manageStateResponse.json();
    assert.deepEqual(manageState.workers.map(worker => worker.id).sort(), ["company-pc", "elysia-pc", "legacy-pc"]);

    const terminalTarget = await fetch(`${baseUrl}/manage/api/apps/${encodeURIComponent(manageState.apps[0].id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ targetDeviceId: "rabi-phone" })
    });
    assert.equal(terminalTarget.status, 400);

    const phoneTarget = await fetch(`${baseUrl}/api/rabilink/mobile/target`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({ targetDeviceId: "rabi-phone" })
    });
    assert.equal(phoneTarget.status, 404);

    const pcTarget = await fetch(`${baseUrl}/api/rabilink/mobile/target`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({ targetDeviceId: "company-pc" })
    });
    assert.equal(pcTarget.status, 200);
    assert.equal((await pcTarget.json()).selectedWorker?.id, "company-pc");
  } finally {
    await Promise.allSettled(subscriptions.map(response => response.body?.cancel()));
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2_000);
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});
