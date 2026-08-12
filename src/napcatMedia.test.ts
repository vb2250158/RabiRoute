import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeNapCatAttachments } from "./napcatMedia.js";

test("NapCat images are saved immediately and returned as readable local attachments", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-media-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const attachments = await materializeNapCatAttachments([
    { type: "image", data: { file: "preview.png", url: "https://example.invalid/preview.png" } }
  ], "[CQ:image,file=preview.png,url=https://example.invalid/preview.png]", {
    dataDir,
    instanceId: "work-qq",
    messageId: "message-1",
    fetch: async () => new Response(png, { headers: { "content-type": "image/png" } })
  });

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.status, "ready");
  assert.equal(attachments[0]?.kind, "image");
  assert.equal(attachments[0]?.sourceMessageId, "message-1");
  assert.ok(attachments[0]?.path && fs.existsSync(attachments[0].path));
  assert.deepEqual(fs.readFileSync(attachments[0]!.path!), png);
});

test("NapCat image download failures remain explicit evidence instead of disappearing", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-napcat-media-failed-"));
  const attachments = await materializeNapCatAttachments([], "[CQ:image,file=missing.png,url=https://example.invalid/missing.png]", {
    dataDir,
    instanceId: "default",
    messageId: "message-2",
    fetch: async () => new Response("expired", { status: 403 })
  });

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]?.status, "unavailable");
  assert.equal(attachments[0]?.path, undefined);
  assert.match(attachments[0]?.error || "", /HTTP 403/);
  assert.doesNotMatch(attachments[0]?.error || "", /example\.invalid/);
});
