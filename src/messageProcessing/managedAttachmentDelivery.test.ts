import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildManagedMessageImageBatches, stageManagedMessageImages } from "./managedAttachmentDelivery.js";

test("message images are staged inside the target workspace with stable content-addressed paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-managed-message-images-"));
  const workspace = path.join(root, "workspace");
  const source = path.join(root, "source.png");
  fs.mkdirSync(workspace);
  fs.writeFileSync(source, Buffer.from([1, 2, 3, 4]));

  const first = stageManagedMessageImages({
    workspace,
    requirementId: "requirement-1",
    attachments: [{ id: "message-1:image:1", path: source }]
  });
  const second = stageManagedMessageImages({
    workspace,
    requirementId: "requirement-1",
    attachments: [{ id: "message-1:image:1", path: source }]
  });

  assert.equal(first.ready.length, 1);
  assert.equal(first.ready[0]?.path, second.ready[0]?.path);
  assert.ok(first.ready[0]?.path.startsWith(path.resolve(workspace) + path.sep));
  assert.deepEqual(fs.readFileSync(first.ready[0]!.path), Buffer.from([1, 2, 3, 4]));
  assert.match(first.ready[0]!.path, /requirement-1/);
  assert.match(first.ready[0]!.path, /message-1_image_1/);
});

test("managed message images are split into stable batches of eight and only the first batch carries the body", () => {
  const images = Array.from({ length: 17 }, (_, index) => ({
    id: `image-${index + 1}`,
    path: `C:\\workspace\\image-${index + 1}.png`,
    contentHash: String(index + 1).padStart(64, "0")
  }));
  const batches = buildManagedMessageImageBatches({ requirementId: "requirement-17", prompt: "正文", images });

  assert.deepEqual(batches.map((batch) => batch.imagePaths.length), [8, 8, 1]);
  assert.deepEqual(batches.map((batch) => batch.batchIndex), [1, 2, 3]);
  assert.ok(batches.every((batch) => batch.batchCount === 3));
  assert.match(String(batches[0]?.prompt), /^正文\n\n本批投递 deliveryId：[0-9a-f-]{36}$/);
  assert.match(batches[1]?.prompt || "", /第 2\/3 批图片/);
  assert.equal(new Set(batches.map((batch) => batch.deliveryId)).size, 3);
  assert.deepEqual(
    buildManagedMessageImageBatches({ requirementId: "requirement-17", prompt: "正文", images }).map((batch) => batch.deliveryId),
    batches.map((batch) => batch.deliveryId)
  );
});

test("managed image staging rejects a symlink that redirects its cache outside the workspace", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-managed-message-symlink-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const source = path.join(root, "source.png");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(source, Buffer.from([5, 6, 7]));
  fs.symlinkSync(outside, path.join(workspace, ".rabiroute-message-images"), "dir");

  assert.throws(() => stageManagedMessageImages({
    workspace,
    requirementId: "requirement-2",
    attachments: [{ id: "message-2:image:1", path: source }]
  }), /symbolic link|workspace/i);
});
