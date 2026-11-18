import assert from "node:assert/strict";
import test from "node:test";
import { prepareNapcatApiAttachmentParams } from "./napcatApiAttachments.js";
import type { NapcatApiSelection, NapcatApiTransportContext } from "./napcatApiTransport.js";

const selection: NapcatApiSelection = { routeId: "fixture", instanceId: "instance", botUserId: "12345", httpUrl: "http://127.0.0.1:12345",
  accessToken: "example-private-token", assertCurrent() {} };
const parameters = { group_id: "789", attachment: { kind: "group", targetId: "789", messageId: "12", attachmentIndex: 0 } };
function fixture(mediaKind = "image", actualAccount = 12345, actualGroup = 789) {
  const calls: string[] = [];
  const context: NapcatApiTransportContext = { local: () => true, route: () => undefined,
    transport: async url => {
      const parsed = new URL(String(url));
      calls.push(parsed.pathname);
      if (parsed.hostname === "media.invalid") return new Response(Buffer.from("fixture-media-bytes"));
      const data = parsed.pathname === "/get_login_info" ? { user_id: actualAccount } : {
        post_type: "message", message_type: "group", group_id: actualGroup, user_id: 456, self_id: 12345, message_id: 12,
        message: [{ type: mediaKind, data: { file: "fixture-file-id", url: "https://media.invalid/selected" } }]
      };
      return Response.json({ status: "ok", retcode: 0, data });
    } };
  return { context, calls };
}

test("managed image parameters come only from the original exact message and media owner", async () => {
  const f = fixture();
  const result = await prepareNapcatApiAttachmentParams(f.context, selection, parameters, "image-file", AbortSignal.timeout(1000));
  assert.equal(result.parameters.group_id, "789");
  assert.equal(result.parameters.file, `base64://${Buffer.from("fixture-media-bytes").toString("base64")}`);
  assert.equal(Object.hasOwn(result.parameters, "attachment"), false);
  assert.equal(JSON.stringify(result.digest).includes("base64"), false);
  assert.equal(JSON.stringify(result.digest).includes("media.invalid"), false);
  assert.deepEqual(f.calls, ["/get_login_info", "/get_msg", "/selected"]);
});

test("account, original chat and media-kind mismatch stop before media retrieval", async () => {
  for (const f of [fixture("image", 99999), fixture("image", 12345, 999), fixture("record")]) {
    await assert.rejects(prepareNapcatApiAttachmentParams(f.context, selection, parameters, "image-file", AbortSignal.timeout(1000)));
    assert.equal(f.calls.includes("/selected"), false);
  }
});

test("audio transcription uses original message proof without reading arbitrary files", async () => {
  const f = fixture("record");
  const result = await prepareNapcatApiAttachmentParams(f.context, selection, { attachment: parameters.attachment }, "audio-message", AbortSignal.timeout(1000));
  assert.deepEqual(result.parameters, { message_id: "12" });
  assert.deepEqual(f.calls, ["/get_login_info", "/get_msg"]);
});
