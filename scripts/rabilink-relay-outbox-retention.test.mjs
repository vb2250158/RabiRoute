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

function startRelay(directory, port) {
  return spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: directory,
      RABILINK_RELAY_OUTBOX_TTL_MS: String(60 * 60 * 1000),
      RABILINK_RELAY_WEBGUI_DIST_DIR: path.join(directory, "missing-webgui")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`relay exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Relay is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("relay did not become healthy");
}

async function stopRelay(child) {
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
}

test("expired explicit-target messages remain until delivered while broadcasts still expire", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-outbox-retention-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = startRelay(directory, port);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForHealth(baseUrl, child);
    const account = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "outbox-retention-test", password: "strong-test-password" })
    });
    const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];
    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Outbox retention" })
    });
    const token = (await appResponse.json()).app.token;
    await fetch(`${baseUrl}/worker/tasks?deviceId=pc-retention&deviceGuid=guid-retention&deviceName=Retention%20PC&waitMs=0`, {
      headers: { "x-rabilink-token": token }
    });
    await fetch(`${baseUrl}/api/rabilink/mobile/target`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({ targetDeviceId: "pc-retention" })
    });

    const push = async (body) => {
      const response = await fetch(`${baseUrl}/worker/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rabilink-token": token },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 200);
      return (await response.json()).messages[0];
    };
    const targeted = await push({
      text: "targeted",
      deliveryId: "retained-targeted",
      proactive: true,
      targetDeviceIds: ["phone-retained", "phone-second"]
    });
    await push({ text: "broadcast", deliveryId: "expired-broadcast", proactive: true });

    await stopRelay(child);
    const runtimePath = path.join(directory, "runtime-state.json");
    const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    for (const message of runtime.outboxMessages) message.createdAt = Date.now() - 2 * 60 * 60 * 1000;
    fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));

    child = startRelay(directory, port);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await waitForHealth(baseUrl, child);
    const pageResponse = await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-retained&deviceKind=phone&after=&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.deepEqual(page.messages.map((message) => message.deliveryId), ["retained-targeted"]);

    const receipt = await fetch(`${baseUrl}/api/rabilink/devices/message-receipts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        messageId: targeted.id,
        deliveryId: targeted.deliveryId,
        deviceId: "phone-retained",
        deviceKind: "phone",
        state: "delivered"
      })
    });
    assert.equal(receipt.status, 200);

    await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-retained&deviceKind=phone&after=${encodeURIComponent(targeted.id)}&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    let persisted = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    assert.equal(persisted.outboxMessages.length, 1, "one explicit target is still unconfirmed");

    const secondReceipt = await fetch(`${baseUrl}/api/rabilink/devices/message-receipts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        deliveryId: targeted.deliveryId,
        deviceId: "phone-second",
        deviceKind: "phone",
        state: "delivered"
      })
    });
    assert.equal(secondReceipt.status, 200);
    await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-second&deviceKind=phone&after=${encodeURIComponent(targeted.id)}&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    persisted = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    assert.equal(persisted.outboxMessages.length, 0);
  } finally {
    await stopRelay(child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});

test("portable cursor replays retained messages after Relay state rollback instead of remaining permanently ahead", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-cursor-recovery-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = startRelay(directory, port);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForHealth(baseUrl, child);
    const account = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "cursor-recovery-test", password: "strong-test-password" })
    });
    const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];
    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Cursor recovery" })
    });
    const token = (await appResponse.json()).app.token;
    const headers = { "content-type": "application/json", "x-rabilink-token": token };
    await fetch(`${baseUrl}/worker/tasks?deviceId=pc-cursor&deviceGuid=guid-cursor&deviceName=Cursor%20PC&waitMs=0`, {
      headers: { "x-rabilink-token": token }
    });
    await fetch(`${baseUrl}/api/rabilink/mobile/target`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targetDeviceId: "pc-cursor" })
    });
    const push = async (deliveryId, text) => {
      const response = await fetch(`${baseUrl}/worker/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, deliveryId, proactive: true, targetDeviceIds: ["phone-cursor"] })
      });
      assert.equal(response.status, 200);
      return await response.json();
    };

    await push("cursor-before-rollback", "before rollback");
    const firstPageResponse = await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-cursor&deviceKind=phone&after=&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    const firstPage = await firstPageResponse.json();
    assert.match(firstPage.nextCursor, /^oc1\./);
    assert.equal(firstPage.cursorReset, false);
    const oldCursor = firstPage.nextCursor;

    const peerPort = await freePort();
    const peerBaseUrl = `http://127.0.0.1:${peerPort}`;
    const peer = startRelay(directory, peerPort);
    peer.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    try {
      await waitForHealth(peerBaseUrl, peer);
      const peerPageResponse = await fetch(`${peerBaseUrl}/api/rabilink/devices/messages?deviceId=phone-cursor&deviceKind=phone&after=${encodeURIComponent(oldCursor)}&waitMs=0&stream=1`, {
        headers: { "x-rabilink-token": token }
      });
      const peerPage = await peerPageResponse.json();
      assert.equal(peerPage.cursorReset, false, "Relay processes sharing a data directory also share the cursor generation");
      assert.equal(peerPage.messages.length, 0);
    } finally {
      await stopRelay(peer);
    }

    await stopRelay(child);
    child = startRelay(directory, port);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await waitForHealth(baseUrl, child);
    const normalRestartResponse = await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-cursor&deviceKind=phone&after=${encodeURIComponent(oldCursor)}&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    const normalRestart = await normalRestartResponse.json();
    assert.equal(normalRestart.cursorReset, false, "a normal Relay restart keeps the shared cursor generation");
    assert.equal(normalRestart.messages.length, 0);

    await stopRelay(child);
    const runtimePath = path.join(directory, "runtime-state.json");
    const rolledBack = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
    rolledBack.outboxMessages = [];
    rolledBack.nextOutboxMessageSeq = 1;
    fs.writeFileSync(runtimePath, JSON.stringify(rolledBack, null, 2));

    child = startRelay(directory, port);
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    await waitForHealth(baseUrl, child);
    const afterRollback = await push("cursor-after-rollback", "after rollback");
    assert.equal(afterRollback.messages[0].id, "out-000000001", "the rollback deliberately reuses the old numeric outbox id");

    const recoveredResponse = await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-cursor&deviceKind=phone&after=${encodeURIComponent(oldCursor)}&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(recoveredResponse.status, 200);
    const recovered = await recoveredResponse.json();
    assert.equal(recovered.cursorReset, true);
    assert.equal(recovered.cursorResetReason, "relay_generation_changed");
    assert.deepEqual(recovered.messages.map((message) => message.deliveryId), ["cursor-after-rollback"]);
    assert.match(recovered.nextCursor, /^oc1\./);
    assert.notEqual(recovered.nextCursor, oldCursor);

    const settledResponse = await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-cursor&deviceKind=phone&after=${encodeURIComponent(recovered.nextCursor)}&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    const settled = await settledResponse.json();
    assert.equal(settled.cursorReset, false);
    assert.equal(settled.messages.length, 0);
  } finally {
    await stopRelay(child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});
