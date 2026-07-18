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

test("relay stores glasses media per application and requires authenticated download", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-device-media-"));
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
      body: JSON.stringify({ username: "device-media-test", password: "strong-test-password" })
    });
    assert.equal(account.status, 200);
    const cookie = String(account.headers.get("set-cookie") || "").split(";")[0];

    const createApp = async (name) => {
      const response = await fetch(`${baseUrl}/manage/api/apps`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name })
      });
      assert.equal(response.status, 200);
      return (await response.json()).app.token;
    };
    const ownerToken = await createApp("Media owner");
    const otherToken = await createApp("Other app");
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4]);
    const upload = await fetch(`${baseUrl}/api/rabilink/devices/media?fileName=..%2Fphoto.jpg`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "x-rabilink-token": ownerToken },
      body: bytes
    });
    assert.equal(upload.status, 201);
    const attachment = (await upload.json()).attachment;
    assert.equal(attachment.fileName, "photo.jpg");
    assert.equal(attachment.kind, "image");
    assert.equal(attachment.size, bytes.length);

    const download = await fetch(`${baseUrl}${attachment.downloadPath}`, {
      headers: { "x-rabilink-token": ownerToken }
    });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);

    const isolated = await fetch(`${baseUrl}${attachment.downloadPath}`, {
      headers: { "x-rabilink-token": otherToken }
    });
    assert.equal(isolated.status, 404);
    assert.equal((await fetch(`${baseUrl}${attachment.downloadPath}`)).status, 401);

    const rejectedType = await fetch(`${baseUrl}/api/rabilink/devices/media?fileName=payload.html`, {
      method: "POST",
      headers: { "content-type": "text/html", "x-rabilink-token": ownerToken },
      body: "not allowed"
    });
    assert.equal(rejectedType.status, 415);
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
