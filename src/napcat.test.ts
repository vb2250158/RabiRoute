import assert from "node:assert/strict";
import test from "node:test";
import { getMessage } from "./napcat.js";

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
