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

async function subscribe(baseUrl, token, identity, secret) {
  const response = await fetch(`${baseUrl}/api/rabilink/events?${new URLSearchParams(identity)}`, {
    headers: { "x-rabilink-token": token, accept: "text/event-stream", ...(secret ? { "x-rabilink-phone-session": secret } : {}) }
  });
  assert.equal(response.status, 200);
  return response;
}

test("phone screen and location connect independently of files and input", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-phone-channels-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    windowsHide: true,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, "missing-webgui") },
    stdio: ["ignore", "ignore", "inherit"]
  });
  const subscriptions = [];
  t.after(async () => {
    await Promise.allSettled(subscriptions.map(response => response.body?.cancel()));
    if (child.exitCode == null && child.signalCode == null) {
      const stopped = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await stopped;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl, child);
  const { token } = await createApp(baseUrl);
  const secret = "1".repeat(64);
  const readPhone = "rabi-phone-readonly";
  const androidPhone = "rabi-phone-android";
  const legacyPhone = "rabi-phone-legacy";
  const noSessionPhone = "rabi-phone-nosession";
  for (const [id, capabilities, session] of [
    [readPhone, "phone-location-v1,phone-screen-v1", secret],
    [androidPhone, "phone-file-control-v1,phone-location-v1,phone-screen-v1,phone-input-v1,phone-apps-v1", "2".repeat(64)],
    [legacyPhone, "", "3".repeat(64)],
    [noSessionPhone, "phone-location-v1,phone-screen-v1", ""]
  ]) {
    const mode = id === readPhone || id === noSessionPhone ? { phoneChannels: "declared" } : {};
    const stream = await subscribe(baseUrl, token, { deviceId: id, deviceKind: "phone", capabilities, ...mode }, session);
    subscriptions.push(stream);
    assert.equal(stream.headers.get("x-rabilink-phone-channels"), id === readPhone ? "declared" : null);
  }
  const directoryResponse = await fetch(`${baseUrl}/api/rabilink/peers?includePortable=phone`, { headers: { "x-rabilink-token": token } });
  assert.equal(directoryResponse.status, 200);
  const { peers } = await directoryResponse.json();
  const caps = id => peers.find(row => row.id === id).capabilities;
  assert.deepEqual([...caps(readPhone)].sort(), ["phone-location-v1", "phone-screen-v1"]);
  assert.ok(caps(androidPhone).includes("phone-files-v1"));
  assert.ok(caps(androidPhone).includes("phone-input-v1"));
  assert.deepEqual(caps(legacyPhone), ["phone-files-v1"]);
  assert.deepEqual(caps(noSessionPhone), []);

  const post = (path, body, session) => fetch(`${baseUrl}/api/rabilink/mobile/${path}`, {
    method: "POST", signal: AbortSignal.timeout(4000),
    headers: { "x-rabilink-token": token, "content-type": "application/json",
      ...(session ? { "x-rabilink-phone-session": session } : {}) },
    body: JSON.stringify(body)
  });
  const unsupported = async (path, body, errorCode) => {
    const response = await post(path, { targetId: readPhone, targetGuid: "", ...body });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).errorCode, errorCode);
  };
  await unsupported("files", { action: "file.list" }, "PHONE_FILES_NOT_CONNECTED");
  await unsupported("screen", { action: "input.perform" }, "PHONE_INPUT_UNAVAILABLE");
  assert.equal((await post("screen/claim", { phoneId: readPhone }, "2".repeat(64))).status, 403);

  const position = { state: "ok", precision: "approximate", latitude: 0, longitude: 0, coordinateSystem: "WGS84",
    observedAt: "2026-11-28T00:00:00Z", provider: "core-location", accuracyMeters: 1500 };
  const capture = { state: "captured", frameId: "fixture-frame", width: 1, height: 1, mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X438AAAAASUVORK5CYII=" };
  for (const [channel, action, data] of [["location", "location.read", position], ["screen", "screen.capture", capture]]) {
    const pending = post(channel, { action, targetId: readPhone, targetGuid: "" });
    let claim;
    for (let i = 0; i < 30 && !claim; i++) {
      const response = await post(channel + "/claim", { phoneId: readPhone }, secret);
      assert.equal(response.status, 200);
      claim = (await response.json()).data;
      if (!claim) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(claim?.action, action);
    const response = await post(channel + "/result", { phoneId: readPhone, requestId: claim.id, status: 200, result: { code: 0, data } }, secret);
    assert.equal(response.status, 200);
    const read = await pending;
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).data, data);
  }
});

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
    const avatarWithoutWorker = await fetch(`${baseUrl}/api/rabilink/mobile/personas/YeYu/avatar?v=test-version`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(avatarWithoutWorker.status, 410);
    assert.equal((await avatarWithoutWorker.json()).code, "PUBLIC_MANAGER_API_REQUIRED");
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
      capabilities: "webgui,speech,asr"
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
    const asrUrl = `${baseUrl}/api/rabilink/mobile/asr-settings`;
    assert.equal((await fetch(asrUrl)).status, 401);
    const asrHeaders = { "content-type": "application/json", "x-rabilink-token": token };
    for (const method of ["GET", "PATCH"]) {
      const retired = await fetch(asrUrl, { method, headers: asrHeaders,
        ...(method === "PATCH" ? { body: JSON.stringify({ priority: ["company-pc"] }) } : {}) });
      assert.equal(retired.status, 410);
      assert.equal((await retired.json()).code, "PUBLIC_MANAGER_API_REQUIRED");
    }
    assert.equal((await (await fetch(`${baseUrl}/api/rabilink/mobile/state`, { headers: asrHeaders })).json()).selectedWorker.id, "company-pc");
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

test("mobile state auto-selects one online processing PC but never guesses between several", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-mobile-autoselect-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1", PORT: String(port), RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, "missing-webgui")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const subscriptions = [];
  try {
    await waitForHealth(baseUrl, child);
    const { token } = await createApp(baseUrl);
    subscriptions.push(await subscribe(baseUrl, token, {
      deviceId: "only-pc", deviceGuid: "guid-only", deviceName: "Only PC", capabilities: "webgui"
    }));
    let stateResponse = await fetch(`${baseUrl}/api/rabilink/mobile/state`, { headers: { "x-rabilink-token": token } });
    assert.equal(stateResponse.status, 200);
    assert.equal((await stateResponse.json()).selectedWorker?.id, "only-pc");

    subscriptions.push(await subscribe(baseUrl, token, {
      deviceId: "other-pc", deviceGuid: "guid-other", deviceName: "Other PC", capabilities: "webgui"
    }));
    stateResponse = await fetch(`${baseUrl}/api/rabilink/mobile/state`, { headers: { "x-rabilink-token": token } });
    assert.equal(stateResponse.status, 200);
    assert.equal((await stateResponse.json()).selectedWorker, null);
  } finally {
    await Promise.allSettled(subscriptions.map(response => response.body?.cancel()));
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve); setTimeout(resolve, 2_000);
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});
