import assert from "node:assert/strict";
import test from "node:test";
import { notifyAstrbot } from "./astrbotAdapter.js";

const managedEnvironment = [
  "ASTRBOT_URL",
  "ASTRBOT_USERNAME",
  "ASTRBOT_PASSWORD",
  "ASTRBOT_SESSION_ID",
  "GATEWAY_MANAGER_URL",
  "GATEWAY_ID"
] as const;

test("AstrBot delivery requires a ChatUI session and uses only /api/chat/send", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const previousEnvironment = new Map(managedEnvironment.map(key => [key, process.env[key]]));
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  process.env.ASTRBOT_URL = "http://127.0.0.1:6185/";
  process.env.ASTRBOT_USERNAME = "tester";
  process.env.ASTRBOT_PASSWORD = "password";
  delete process.env.ASTRBOT_SESSION_ID;
  delete process.env.GATEWAY_MANAGER_URL;
  delete process.env.GATEWAY_ID;
  console.log = () => undefined;
  console.error = () => undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({ url, init });
    if (url === "http://127.0.0.1:6185/api/auth/login") {
      return new Response(JSON.stringify({ status: "ok", data: { token: "token-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url === "http://127.0.0.1:6185/api/chat/send") {
      return new Response('data: {"type":"plain","data":"reply"}\n\n', { status: 200 });
    }
    throw new Error(`Unexpected AstrBot request: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      notifyAstrbot("missing session"),
      /ASTRBOT_SESSION_ID is required/
    );
    assert.deepEqual(requests.map(item => item.url), [
      "http://127.0.0.1:6185/api/auth/login"
    ]);

    process.env.ASTRBOT_SESSION_ID = "session-123";
    await notifyAstrbot("hello");

    assert.deepEqual(requests.map(item => item.url), [
      "http://127.0.0.1:6185/api/auth/login",
      "http://127.0.0.1:6185/api/chat/send"
    ]);
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      username: "tester",
      password: "password"
    });
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      session_id: "session-123",
      message: "hello",
      enable_streaming: false
    });
    assert.equal(requests.some(item => item.url.includes("rabiroute_agent")), false);
    assert.equal(requests.some(item => item.url.includes("/api/plug/")), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
