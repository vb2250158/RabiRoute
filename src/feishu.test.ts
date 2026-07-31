import assert from "node:assert/strict";
import test from "node:test";
import { sendFeishuText } from "./feishu.js";

test("Feishu app reply obtains a tenant token then sends to the source chat", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(calls.length === 1
      ? { code: 0, tenant_access_token: "test-token" }
      : { code: 0, data: { message_id: "om_test" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await sendFeishuText({ appId: "app", appSecret: "secret" }, "oc_chat", "hello");
    assert.equal(result.messageId, "om_test");
    assert.match(calls[0].url, /tenant_access_token/);
    assert.match(calls[1].url, /receive_id_type=chat_id/);
    assert.match(String(calls[1].init?.headers && new Headers(calls[1].init.headers).get("authorization")), /Bearer test-token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Feishu app reply fails closed when credentials are incomplete", async () => {
  await assert.rejects(() => sendFeishuText({ appId: "", appSecret: "" }, "oc_chat", "hello"), /credentials/i);
});
