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

function openRelayEvents(response: http.ServerResponse, extra = ""): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  response.write("event: ready\ndata: {}\n\n");
  if (extra) response.write(extra);
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
      openRelayEvents(
        response,
        "event: outbox_receipt\ndata: {\"deliveryId\":\"delivery-a\",\"deviceId\":\"phone-a\",\"state\":\"played\",\"routeProfileId\":\"route-a\"}\n\n"
      );
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

  const relayEvents: Array<{ eventType: string; data: Record<string, unknown> }> = [];
  const runtime = new RabiLinkRelayRuntime({ onEvent: (eventType, data) => relayEvents.push({ eventType, data }) });
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
  assert.ok(relayEvents.some((event) => event.eventType === "ready"));
  assert.deepEqual(
    relayEvents.find((event) => event.eventType === "outbox_receipt")?.data,
    { deliveryId: "delivery-a", deviceId: "phone-a", state: "played", routeProfileId: "route-a" }
  );
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

  await runtime.stop();
  assert.equal(runtime.status().state, "disabled");
});

test("global Relay runtime forwards media ranges and Manager SSE events without exposing Relay credentials locally", async (t) => {
  const mediaBody = Buffer.from("part", "utf8");
  const localState: {
    eventHeaders?: http.IncomingHttpHeaders;
    mediaHeaders?: http.IncomingHttpHeaders;
  } = {};
  const localWebgui = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/events") {
      localState.eventHeaders = request.headers;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      response.write("event: ready\ndata: {}\n\n");
      response.write(": keepalive\n\n");
      response.write("event: gateway_status\ndata: {\"gatewayId\":\"route-a\",\"running\":true}\n\n");
      return;
    }
    if (request.method === "GET" && request.url === "/api/roles/Rabi/plans/plan-a/attachments/video-a") {
      localState.mediaHeaders = request.headers;
      response.writeHead(206, {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-range": "bytes 0-3/10"
      });
      response.end(mediaBody);
      return;
    }
    response.writeHead(404).end();
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  let eventPostCount = 0;
  const relayState: {
    finishedBody?: Record<string, unknown>;
    eventBody?: Record<string, unknown>;
  } = {};
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
        requests: claimCount === 1 ? [{
          id: "request-range",
          method: "GET",
          path: "/api/roles/Rabi/plans/plan-a/attachments/video-a",
          headers: {
            range: "bytes=0-3",
            "if-range": "media-etag",
            authorization: "Bearer must-not-reach-manager",
            "x-rabilink-token": "must-not-reach-manager"
          }
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-range/response") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.finishedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-events") {
      eventPostCount += 1;
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.eventBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(202, { "content-type": "application/json" });
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
    token: "relay-app-token",
    deviceId: "pc-range",
    deviceGuid: "guid-range",
    deviceName: "Range PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitFor(() => relayState.finishedBody !== undefined && relayState.eventBody !== undefined);
  assert.equal(localState.mediaHeaders?.range, "bytes=0-3");
  assert.equal(localState.mediaHeaders?.["if-range"], "media-etag");
  assert.equal(localState.mediaHeaders?.authorization, undefined);
  assert.equal(localState.mediaHeaders?.["x-rabilink-token"], undefined);
  assert.equal(localState.eventHeaders?.authorization, undefined);
  assert.equal(localState.eventHeaders?.["x-rabilink-token"], undefined);
  assert.equal(relayState.finishedBody?.statusCode, 206);
  assert.deepEqual(Buffer.from(String(relayState.finishedBody?.bodyBase64), "base64"), mediaBody);
  assert.deepEqual(relayState.eventBody, {
    streamPath: "/api/events",
    eventType: "gateway_status",
    data: { gatewayId: "route-a", running: true },
    deviceId: "pc-range",
    deviceGuid: "guid-range"
  });
  assert.equal(eventPostCount, 1);
});

test("global Relay runtime hot-forwards supported SSE channels without finite-response self-proxy leaks", async (t) => {
  const localConnections = new Map<string, number>();
  const localWebgui = http.createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    localConnections.set(pathname, (localConnections.get(pathname) || 0) + 1);
    if (request.method === "GET" && ["/api/events", "/api/speech/events"].includes(pathname)) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      response.write("event: ready\ndata: {}\n\n");
      if (pathname === "/api/events") {
        response.write("event: gateway_status\ndata: {\"gatewayId\":\"route-hot\",\"running\":true}\n\n");
      } else {
        response.write("event: speech_status\ndata: {\"state\":\"ready\"}\n\n");
      }
      return;
    }
    response.writeHead(404).end();
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let claimCount = 0;
  const relayState: {
    eventBodies: Record<string, unknown>[];
    rejectedBody?: Record<string, unknown>;
  } = { eventBodies: [] };
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
        requests: claimCount === 1 ? [{
          id: "request-invalid-sse-proxy",
          method: "GET",
          path: "/api/speech/events",
          headers: { accept: "text/event-stream" }
        }] : []
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-events") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.eventBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/webgui-requests/request-invalid-sse-proxy/response") {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        relayState.rejectedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
    token: "relay-hot-token",
    deviceId: "pc-hot",
    deviceGuid: "guid-hot",
    deviceName: "Hot PC",
    claimWaitMs: 60000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  });

  await waitFor(() => {
    const paths = new Set(relayState.eventBodies.map(body => String(body.streamPath || "")));
    return paths.has("/api/events") && paths.has("/api/speech/events") && relayState.rejectedBody !== undefined;
  }, 3000);

  assert.equal(localConnections.get("/api/events"), 1);
  assert.equal(localConnections.get("/api/speech/events"), 1);
  assert.equal(relayState.rejectedBody?.ok, false);
  assert.equal(relayState.rejectedBody?.statusCode, 502);
  assert.match(
    Buffer.from(String(relayState.rejectedBody?.bodyBase64 || ""), "base64").toString("utf8"),
    /SSE event streams must use the Relay event channel/
  );
});

test("global Relay runtime bounds a stuck local GET and retries an uncertain Relay completion", async (t) => {
  let localRequestCount = 0;
  const localWebgui = http.createServer((request, response) => {
    if (request.url !== "/gateways") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ recovered: false }));
      return;
    }
    localRequestCount += 1;
    if (localRequestCount === 1) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ recovered: true }));
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


test("stop aborts active local proxies, suppresses completion writes, and permits restart", async (t) => {
  let slowRequestStarted = false;
  let slowRequestClosed = false;
  const localWebgui = http.createServer((request, response) => {
    if (request.url === "/slow") {
      slowRequestStarted = true;
      response.once("close", () => { slowRequestClosed = true; });
      return;
    }
    if (request.url === "/fast") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ restarted: true }));
      return;
    }
    response.writeHead(404).end();
  });
  const localPort = await listen(localWebgui);
  t.after(() => close(localWebgui));

  let phase: "stopping" | "restarted" = "stopping";
  let slowClaimed = false;
  let fastClaimed = false;
  const completionIds: string[] = [];
  const relay = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/rabilink/events") {
      openRelayEvents(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/webgui-requests") {
      let requests: Array<{ id: string; method: string; path: string }> = [];
      if (phase === "stopping" && !slowClaimed) {
        slowClaimed = true;
        requests = [{ id: "request-stop", method: "GET", path: "/slow" }];
      } else if (phase === "restarted" && !fastClaimed) {
        fastClaimed = true;
        requests = [{ id: "request-restart", method: "GET", path: "/fast" }];
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, requests }));
      return;
    }
    const completion = /^\/worker\/webgui-requests\/([^/]+)\/response$/.exec(url.pathname);
    if (request.method === "POST" && completion) {
      completionIds.push(decodeURIComponent(completion[1]));
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const runtime = new RabiLinkRelayRuntime({ localRequestTimeoutMs: 10_000 });
  t.after(() => runtime.stop());
  const config = {
    enabled: true,
    url: `http://127.0.0.1:${relayPort}`,
    token: "relay-app-token",
    deviceId: "pc-stop",
    deviceGuid: "guid-stop",
    deviceName: "Stop PC",
    claimWaitMs: 60_000,
    localWebguiUrl: `http://127.0.0.1:${localPort}`,
    speechProxyEnabled: false,
    localSpeechUrl: "http://127.0.0.1:8781"
  };
  await runtime.sync(config);
  await waitFor(() => slowRequestStarted);

  const firstStop = runtime.stop();
  const queuedSync = runtime.sync(config);
  const secondStop = runtime.stop();
  assert.strictEqual(firstStop, secondStop);
  await Promise.all([firstStop, queuedSync]);
  assert.equal(runtime.status().state, "disabled");
  await waitFor(() => slowRequestClosed);
  assert.equal(completionIds.length, 0);

  phase = "restarted";
  await runtime.sync(config);
  await waitFor(() => completionIds.includes("request-restart"));
  assert.equal(completionIds.includes("request-stop"), false);
  assert.equal(runtime.status().state, "online");
  await runtime.stop();
});
