import assert from "node:assert/strict";
import test from "node:test";
import { getLoginInfo, getMessage } from "./napcat.js";

for (const blockedStage of ["headers", "body"] as const) {
  test(`NapCat login deadline bounds stalled ${blockedStage}, including transports ignoring abort`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let signal: AbortSignal | null | undefined;
    const never = new Promise<never>(() => undefined);
    globalThis.fetch = (async (_input, init) => {
      signal = init?.signal;
      if (blockedStage === "headers") return await never;
      return { ok: true, text: () => never } as unknown as Response;
    }) as typeof fetch;
    const startedAt = Date.now();
    await assert.rejects(getLoginInfo({ httpUrl: "http://mock.invalid", accessToken: "fake-fixture-token" }, { timeoutMs: 30 }), /timed out/);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(signal?.aborted, true);
  });
}

test("NapCat login remains compatible without options and accepts bounded reads", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = (async () => new Response(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: "9000", nickname: "fixture" } }))) as typeof fetch;
  const endpoint = { httpUrl: "http://mock.invalid", accessToken: "" };
  assert.deepEqual(await getLoginInfo(endpoint), { userId: "9000", nickname: "fixture" });
  assert.deepEqual(await getLoginInfo(endpoint, { timeoutMs: 2_000 }), { userId: "9000", nickname: "fixture" });
});

test("NapCat get_msg normalizes message metadata and preserves CQ segments", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody = "";
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      status: "ok",
      retcode: 0,
      data: {
        self_id: 9000,
        user_id: 9000,
        time: 10,
        message_id: 3000,
        message_type: "group",
        group_id: 7000,
        sender: {
          user_id: 9000,
          nickname: "路由助手",
          card: "群名片"
        },
        message: [
          { type: "reply", data: { id: "2000" } },
          { type: "at", data: { qq: "1000" } },
          { type: "text", data: { text: "说明" } }
        ]
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const message = await getMessage("3000", {
      httpUrl: "http://127.0.0.1:3000/",
      accessToken: "test-token"
    });

    assert.equal(requestUrl, "http://127.0.0.1:3000/get_msg");
    assert.deepEqual(JSON.parse(requestBody), { message_id: "3000" });
    assert.equal(message.messageId, 3000);
    assert.equal(message.senderName, "群名片");
    assert.equal(message.rawMessage, "[CQ:reply,id=2000][CQ:at,qq=1000]说明");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
