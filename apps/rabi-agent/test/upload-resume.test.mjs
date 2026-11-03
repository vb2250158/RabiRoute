import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Ajv from "ajv";
import { ComputerService } from "../lib/computer-service.mjs";
import { computerResponseSchema } from "../lib/interactive-protocol.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-upload-resume-"));
  const service = new ComputerService({ uploadHistoryRoot: path.join(root, "history"), ...options });
  t.after(async () => { await service.stop(); assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true }); });
  const begin = (name, extra = {}) => ({ action: "upload.begin", uploadId: randomUUID(), path: path.join(root, name), size: 0, sha256: sha(""), ...extra });
  return { root, service, begin };
}
test("missing status and cancellation are readable observations, not permanent ID bans", async t => {
  const f = fixture(t), req = f.begin("file.bin"), expected = { uploadId: req.uploadId, state: "absent" };
  assert.deepEqual(await f.service.execute({ action: "upload.status", uploadId: req.uploadId }), expected);
  assert.deepEqual(await f.service.execute({ action: "upload.abort", uploadId: req.uploadId }), expected);
  assert.equal(new Ajv({ strict: false }).compile(computerResponseSchema)(expected), true);
  assert.equal((await f.service.execute(req)).state, "uploading");
  assert.deepEqual(await f.service.execute(req), await f.service.execute({ action: "upload.status", uploadId: req.uploadId }));
});
test("temporary capacity refusal permits the exact same begin after its real resource is released", async t => {
  const f = fixture(t, { maxActiveUploads: 1 }), first = f.begin("active.bin"), next = f.begin("next.bin");
  await f.service.execute(first); await assert.rejects(f.service.execute(next), /MAX_ACTIVE_UPLOADS/);
  assert.equal((await f.service.execute({ action: "upload.status", uploadId: next.uploadId })).state, "absent");
  await f.service.execute({ action: "upload.abort", uploadId: first.uploadId });
  assert.equal((await f.service.execute(next)).state, "uploading");
});
test("a missing directory can be prepared and the original ID resumed without writing another target", async t => {
  const f = fixture(t), req = f.begin(path.join("prepared-later", "file.bin"));
  await assert.rejects(f.service.execute(req), /ENOENT/); fs.mkdirSync(path.dirname(req.path));
  assert.equal((await f.service.execute(req)).state, "uploading");
  assert.equal(f.service.uploads.size, 1); assert.equal(fs.existsSync(req.path), false);
});
test("completed records do not block upload 65 and old original receipts remain available", async t => {
  const f = fixture(t); let first;
  for (let n = 0; n < 65; n++) { const req = f.begin(n + ".bin"); first ??= req; await f.service.execute(req); await f.service.execute({ action: "upload.commit", uploadId: req.uploadId }); }
  assert.equal(f.service.uploads.size, 64); assert.equal(f.service.activeCount, 0);
  assert.equal((await f.service.execute({ action: "upload.status", uploadId: first.uploadId })).state, "committed");
});
test("same-ID resume preserves accepted bytes and rejects a different intent", async t => {
  const f = fixture(t), bytes = Buffer.from("original"), req = f.begin("bytes.bin", { size: bytes.length, sha256: sha(bytes) });
  await f.service.execute(req); await f.service.execute({ action: "upload.write", uploadId: req.uploadId, offset: 0, data: bytes.toString("base64"), sha256: sha(bytes) });
  assert.equal((await f.service.execute(req)).offset, bytes.length);
  await assert.rejects(f.service.execute({ ...req, path: path.join(f.root, "another.bin") }), /conflicts/);
  await f.service.execute({ action: "upload.commit", uploadId: req.uploadId }); assert.deepEqual(fs.readFileSync(req.path), bytes);
});
test("missing owner never overwrites an orphan temporary or existing destination", async t => {
  const f = fixture(t), req = f.begin("orphan.bin"), temp = path.join(f.root, ".rabi-upload-" + req.uploadId + ".tmp");
  fs.writeFileSync(temp, "retain"); assert.equal((await f.service.execute({ action: "upload.status", uploadId: req.uploadId })).state, "absent");
  await assert.rejects(f.service.execute(req), /EEXIST/); assert.equal(fs.readFileSync(temp, "utf8"), "retain");
  const existing = f.begin("existing.bin"); fs.writeFileSync(existing.path, "keep");
  await assert.rejects(f.service.execute(existing), /already exists/); assert.equal(fs.readFileSync(existing.path, "utf8"), "keep");
});
