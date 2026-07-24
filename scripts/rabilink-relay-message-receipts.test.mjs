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

test("portable devices persist idempotent delivered and played receipts for their targeted message", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-message-receipts-"));
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
    const account = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "message-receipt-test", password: "strong-test-password" })
    });
    assert.equal(account.status, 200);
    const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];
    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Message receipts" })
    });
    const token = (await appResponse.json()).app.token;
    await fetch(`${baseUrl}/worker/tasks?deviceId=pc-receipts&deviceGuid=guid-receipts&deviceName=Receipt%20PC&waitMs=0`, {
      headers: { "x-rabilink-token": token }
    });
    await fetch(`${baseUrl}/api/rabilink/mobile/target`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({ targetDeviceId: "pc-receipts" })
    });
    const pushed = await fetch(`${baseUrl}/worker/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify({
        text: "receipt smoke",
        deliveryId: "receipt-delivery-one",
        proactive: true,
        targetDeviceIds: ["phone-one"],
        targetDeviceKinds: ["phone"],
        presentation: ["text", "tts"]
      })
    });
    assert.equal(pushed.status, 200);
    const pushedBody = await pushed.json();
    const messageId = pushedBody.messages[0].id;

    const postReceipt = (body) => fetch(`${baseUrl}/api/rabilink/devices/message-receipts`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rabilink-token": token },
      body: JSON.stringify(body)
    });
    const delivered = await postReceipt({
      messageId,
      deliveryId: "receipt-delivery-one",
      deviceId: "phone-one",
      deviceKind: "phone",
      state: "delivered"
    });
    assert.equal(delivered.status, 200);
    const deliveredAt = (await delivered.json()).receipt.deliveredAt;
    assert.equal(typeof deliveredAt, "number");

    const deliveredRetry = await postReceipt({
      deliveryId: "receipt-delivery-one",
      deviceId: "phone-one",
      deviceKind: "phone",
      state: "delivered"
    });
    assert.equal(deliveredRetry.status, 200);
    assert.equal((await deliveredRetry.json()).receipt.deliveredAt, deliveredAt);

    const played = await postReceipt({
      deliveryId: "receipt-delivery-one",
      deviceId: "phone-one",
      deviceKind: "phone",
      state: "played"
    });
    assert.equal(played.status, 200);
    const playedReceipt = (await played.json()).receipt;
    assert.equal(playedReceipt.deliveredAt, deliveredAt);
    assert.equal(typeof playedReceipt.playedAt, "number");

    const wrongDevice = await postReceipt({
      deliveryId: "receipt-delivery-one",
      deviceId: "phone-two",
      deviceKind: "tablet",
      state: "played"
    });
    assert.equal(wrongDevice.status, 403);

    const pageResponse = await fetch(`${baseUrl}/api/rabilink/devices/messages?deviceId=phone-one&deviceKind=phone&after=&waitMs=0&stream=1`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json();
    assert.equal(page.messages.length, 1);
    assert.deepEqual(page.messages[0].receipts, [playedReceipt]);

    const persisted = JSON.parse(fs.readFileSync(path.join(directory, "runtime-state.json"), "utf8"));
    assert.deepEqual(persisted.outboxMessages[0].receipts, [playedReceipt]);
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
