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
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for Relay runtime state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openRelayEvents(response: http.ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  response.write("event: ready\ndata: {}\n\n");
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
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      claimCount += 1;
      if (claimCount === 1) {
        claimedIdentity = {
          token: String(request.headers["x-rabilink-token"] || ""),
          deviceId: url.searchParams.get("deviceId") || "",
          deviceGuid: url.searchParams.get("deviceGuid") || "",
          deviceName: url.searchParams.get("deviceName") || "",
          waitMs: url.searchParams.get("waitMs") || "",
          capabilities: url.searchParams.get("capabilities") || "",
          peerUrls: url.searchParams.get("peerUrls") || ""
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

  const relayEvents: string[] = [];
  const runtime = new RabiLinkRelayRuntime({ onEvent: eventType => relayEvents.push(eventType) });
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    peerUrls: ["http://192.168.1.10:8790"],
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitFor(() => relayState.finishedBody !== undefined);
  const finishedBody = relayState.finishedBody;
  assert.ok(finishedBody);
  assert.equal(runtime.status().state, "online");
  assert.ok(relayEvents.includes("ready"));
  assert.deepEqual(claimedIdentity, {
    token: "app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    waitMs: "0",
    capabilities: "webgui,persona-sync",
    peerUrls: JSON.stringify(["http://192.168.1.10:8790"])
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
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
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
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
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

test("global Relay runtime proxies the independent speech plugin without exposing Relay credentials", async (t) => {
  const requestPayload = Buffer.from("fake-multipart-audio", "utf8");
  const wavPayload = Buffer.from("RIFF-test-wave", "utf8");
  const localState: Record<string, unknown> = {};
  const localSpeech = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      localState.method = request.method;
      localState.url = request.url;
      localState.authorization = request.headers.authorization;
      localState.contentType = request.headers["content-type"];
      localState.body = Buffer.concat(chunks);
      response.writeHead(200, { "content-type": "audio/wav", "x-rabi-provider": "fake-tts" });
      response.end(wavPayload);
    });
  });
  const localSpeechPort = await listen(localSpeech);
  t.after(() => close(localSpeech));

  let speechClaimCount = 0;
  let declaredCapabilities = "";
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests: [] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/speech-requests") {
      speechClaimCount += 1;
      declaredCapabilities = url.searchParams.get("capabilities") || "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: speechClaimCount === 1 ? [{
          id: "speech-1",
          method: "POST",
          path: "/v1/audio/transcriptions?language=zh",
          headers: {
            authorization: "Bearer must-not-reach-local-service",
            "content-type": "multipart/form-data; boundary=test-boundary"
          },
          bodyBase64: requestPayload.toString("base64")
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/speech-requests/speech-1/response") {
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

  const runtime = new RabiLinkRelayRuntime({ localSpeechRequestTimeoutMs: 1000 });
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: "http://127.0.0.1:8790",
    speechProxyEnabled: true,
    localSpeechUrl: `http://127.0.0.1:${localSpeechPort}`
  });

  await waitFor(() => relayState.finishedBody !== undefined);
  assert.equal(declaredCapabilities, "webgui,persona-sync,speech");
  assert.equal(localState.method, "POST");
  assert.equal(localState.url, "/v1/audio/transcriptions?language=zh");
  assert.equal(localState.authorization, undefined);
  assert.equal(localState.contentType, "multipart/form-data; boundary=test-boundary");
  assert.deepEqual(localState.body, requestPayload);
  assert.equal(relayState.finishedBody?.statusCode, 200);
  assert.deepEqual(Buffer.from(String(relayState.finishedBody?.bodyBase64), "base64"), wavPayload);
});

test("global Relay runtime sends completed mobile ASR messages to Manager instead of the speech worker", async (t) => {
  const payload = Buffer.from(JSON.stringify({
    recordId: "phone-audio-one",
    text: "手机语音",
    messageAdapterType: "rabilink",
    channelType: "rabilink.mobile_audio",
    routeProfileId: "mobile-main",
    sourceDeviceId: "phone-one"
  }), "utf8");
  const managerState: Record<string, unknown> = {};
  const manager = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      managerState.url = request.url;
      managerState.body = Buffer.concat(chunks);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, data: { status: "delivered" } }));
    });
  });
  const managerPort = await listen(manager);
  t.after(() => close(manager));

  let claimCount = 0;
  const relayState: { finishedBody?: Record<string, unknown> } = {};
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests: [] }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/speech-requests") {
      claimCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        requests: claimCount === 1 ? [{
          id: "speech-message-1",
          method: "POST",
          path: "/api/speech/messages",
          headers: { "content-type": "application/json" },
          bodyBase64: payload.toString("base64")
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/speech-requests/speech-message-1/response") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
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

  const runtime = new RabiLinkRelayRuntime({ localSpeechRequestTimeoutMs: 1000 });
  t.after(() => runtime.stop());
  runtime.sync({
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-a",
    deviceGuid: "guid-a",
    deviceName: "Test PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${managerPort}`,
    speechProxyEnabled: true,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitFor(() => relayState.finishedBody !== undefined);
  assert.equal(managerState.url, "/api/speech/messages");
  assert.deepEqual(managerState.body, payload);
  assert.equal(relayState.finishedBody?.statusCode, 200);
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
    localWebguiUrl: "http://127.0.0.1:8790",
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });
  assert.equal(runtime.status().state, "incomplete");
});
