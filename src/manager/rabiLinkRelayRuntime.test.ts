import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { RabiLinkRelayRuntime } from "./rabiLinkRelayRuntime.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test server port."));
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for Relay runtime state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("global Relay runtime registers the PC and proxies remote WebGUI requests", async (t) => {
  const localWebgui = http.createServer((request, response) => {
    response.writeHead(request.url === "/meta" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ local: request.url === "/meta" }));
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  let claimedIdentity: Record<string, string> = {};
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      if (claimCount === 1) {
        claimedIdentity = {
          token: String(request.headers["x-rabilink-token"] || ""),
          deviceId: url.searchParams.get("deviceId") || "",
          deviceGuid: url.searchParams.get("deviceGuid") || "",
          deviceName: url.searchParams.get("deviceName") || "",
          waitMs: url.searchParams.get("waitMs") || ""
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{ id: "request-1", method: "GET", path: "/meta" }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-1/response") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime();
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`
  });

  await waitFor(() => relayState.finishedBody !== undefined);
  const finishedBody = relayState.finishedBody;
  assert.ok(finishedBody);
  assert.equal(runtime.status().state, "online");
  assert.deepEqual(claimedIdentity, {
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    waitMs: "0"
  });
  assert.equal(finishedBody?.deviceId, "pc-a");
  assert.equal(finishedBody?.deviceGuid, "guid-a");
  assert.equal(finishedBody?.statusCode, 200);
  assert.deepEqual(JSON.parse(Buffer.from(String(finishedBody?.bodyBase64), "base64").toString("utf8")), { local: true });

  runtime.stop();
  assert.equal(runtime.status().state, "disabled");
});

test("global Relay runtime bounds a stuck local GET and retries an uncertain Relay completion", async (t) => {
  let localRequestCount = 0;
  const localWebgui = http.createServer((request, response) => {
    localRequestCount += 1;
    if (localRequestCount === 1) return;
    response.writeHead(request.url === "/gateways" ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ recovered: request.url === "/gateways" }));
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  let finishCount = 0;
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{ id: "request-retry", method: "GET", path: "/gateways" }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-retry/response") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        finishCount += 1;
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (finishCount === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, deduplicated: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({
    localRequestTimeoutMs: 100,
    localRequestAttempts: 2,
    relayWriteTimeoutMs: 200,
    relayWriteAttempts: 2
  });
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`
  });

  await waitFor(() => finishCount >= 2, 3000);
  assert.equal(localRequestCount, 2);
  assert.equal(finishCount, 2);
  assert.equal(relayState.finishedBody?.statusCode, 200);
  assert.deepEqual(
    JSON.parse(Buffer.from(String(relayState.finishedBody?.bodyBase64), "base64").toString("utf8")),
    { recovered: true }
  );
});

test("global Relay runtime reports incomplete configuration without making a request", () => {
  const runtime = new RabiLinkRelayRuntime();
  runtime.sync({
    enabled: true,
    url: "",
    token: "",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: "http://127.0.0.1:8790"
  });
  assert.equal(runtime.status().state, "incomplete");
});
