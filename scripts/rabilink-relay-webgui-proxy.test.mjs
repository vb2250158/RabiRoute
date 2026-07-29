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

async function readUntil(reader, expected, timeoutMs = 2000) {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!text.includes(expected)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for SSE text: ${expected}`);
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for SSE text: ${expected}`)), remaining))
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  assert.match(text, new RegExp(expected));
}

test("remote WebGUI proxies authenticated media ranges and isolated hot SSE channels", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-webgui-proxy-"));
  const dataDirectory = path.join(directory, "data");
  const webguiDirectory = path.join(directory, "webgui");
  fs.mkdirSync(webguiDirectory, { recursive: true });
  fs.writeFileSync(path.join(webguiDirectory, "index.html"), "<!doctype html><html><head></head><body>WebGUI</body></html>");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: dataDirectory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: webguiDirectory,
      RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS: "5000",
      RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES: String(1024 * 1024)
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
      body: JSON.stringify({ username: "proxy-test", password: "strong-test-password" })
    });
    assert.equal(accountResponse.status, 200);
    const cookie = String(accountResponse.headers.get("set-cookie") || "").split(";")[0];

    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Proxy app" })
    });
    assert.equal(appResponse.status, 200);
    const token = (await appResponse.json()).app.token;
    const workerQuery = "deviceId=pc-proxy&deviceGuid=guid-proxy&deviceName=Proxy%20PC&waitMs=0&capabilities=webgui";
    const workerHeaders = { "x-rabilink-token": token };
    assert.equal((await fetch(`${baseUrl}/worker/webgui-requests?${workerQuery}`, { headers: workerHeaders })).status, 200);

    const remotePrefix = `${baseUrl}/manage/proxy-test/guid-proxy`;
    const mediaPromise = fetch(`${remotePrefix}/api/roles/Rabi/plans/plan-a/attachments/video-a`, {
      headers: { cookie, range: "bytes=0-3" }
    });
    const claimResponse = await fetch(
      `${baseUrl}/worker/webgui-requests?deviceId=pc-proxy&deviceGuid=guid-proxy&deviceName=Proxy%20PC&waitMs=1000&capabilities=webgui`,
      { headers: workerHeaders }
    );
    assert.equal(claimResponse.status, 200);
    const claimed = (await claimResponse.json()).requests[0];
    assert.ok(claimed);
    const mediaBody = Buffer.from("test", "utf8");
    const finishResponse = await fetch(`${baseUrl}/worker/webgui-requests/${encodeURIComponent(claimed.id)}/response`, {
      method: "POST",
      headers: { ...workerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        ok: true,
        statusCode: 206,
        headers: {
          "content-type": "video/mp4",
          "accept-ranges": "bytes",
          "content-range": "bytes 0-3/10"
        },
        bodyBase64: mediaBody.toString("base64"),
        deviceId: "pc-proxy",
        deviceGuid: "guid-proxy"
      })
    });
    assert.equal(finishResponse.status, 200);
    assert.equal(claimed.headers.range, "bytes=0-3");

    const mediaResponse = await mediaPromise;
    assert.equal(mediaResponse.status, 206);
    assert.equal(mediaResponse.headers.get("accept-ranges"), "bytes");
    assert.equal(mediaResponse.headers.get("content-range"), "bytes 0-3/10");
    assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), mediaBody);

    const eventController = new AbortController();
    const eventTimer = setTimeout(() => eventController.abort(), 2000);
    const eventResponse = await fetch(`${remotePrefix}/api/events`, {
      headers: { cookie },
      signal: eventController.signal
    });
    clearTimeout(eventTimer);
    assert.equal(eventResponse.status, 200);
    assert.match(eventResponse.headers.get("content-type") || "", /text\/event-stream/);
    const reader = eventResponse.body.getReader();
    await readUntil(reader, "event: ready");

    const speechEventController = new AbortController();
    const speechEventTimer = setTimeout(() => speechEventController.abort(), 2000);
    const speechEventResponse = await fetch(`${remotePrefix}/api/speech/events`, {
      headers: { cookie },
      signal: speechEventController.signal
    });
    clearTimeout(speechEventTimer);
    assert.equal(speechEventResponse.status, 200);
    assert.match(speechEventResponse.headers.get("content-type") || "", /text\/event-stream/);
    const speechReader = speechEventResponse.body.getReader();
    await readUntil(speechReader, "event: ready");

    const publishResponse = await fetch(`${baseUrl}/worker/webgui-events`, {
      method: "POST",
      headers: { ...workerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pc-proxy",
        deviceGuid: "guid-proxy",
        streamPath: "/api/events",
        eventType: "gateway_status",
        data: { gatewayId: "route-a", running: true }
      })
    });
    assert.equal(publishResponse.status, 202);
    await readUntil(reader, "event: gateway_status");

    const speechPublishResponse = await fetch(`${baseUrl}/worker/webgui-events`, {
      method: "POST",
      headers: { ...workerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pc-proxy",
        deviceGuid: "guid-proxy",
        streamPath: "/api/speech/events",
        eventType: "speech_status",
        data: { state: "ready" }
      })
    });
    assert.equal(speechPublishResponse.status, 202);
    await readUntil(speechReader, "event: speech_status");
    await reader.cancel();
    await speechReader.cancel();

    const oversizedResponse = await fetch(`${baseUrl}/worker/webgui-requests/oversized/response`, {
      method: "POST",
      headers: { ...workerHeaders, "content-type": "application/json" },
      body: JSON.stringify({ bodyBase64: "A".repeat(3 * 1024 * 1024) })
    });
    assert.equal(oversizedResponse.status, 413);
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
