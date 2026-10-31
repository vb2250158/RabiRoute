import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlan } from "../roleKnowledge.js";
import { planJsonFile } from "../planStorageLayout.js";
import { createPlanAttachmentOwner } from "./planAttachmentRoutes.js";

async function getAttachment(pathname: string, roleDir: string, range?: string) {
  const request = { method: "GET", headers: range ? { range } : {} } as http.IncomingMessage;
  const parts = pathname.split('/').map(decodeURIComponent);
  try {
    const result = createPlanAttachmentOwner({ roleDir: () => roleDir }).prepare(request, parts[3], parts[5], parts[7]).read(range);
    return { statusCode: result.status, headers: result.headers as http.OutgoingHttpHeaders, body: () => result.bytes ?? Buffer.alloc(0) };
  } catch (error) {
    const cause = error as { statusCode?: number; code?: string };
    const status = cause.statusCode ?? (/not found|unavailable|managed directories/i.test(String(error)) ? 404 : 500);
    return { statusCode: status, headers: {} as http.OutgoingHttpHeaders, body: () => Buffer.from(String(error)) };
  }
}

function clean(directory: string) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('rabiroute-plan-'));
  fs.rmSync(directory, { recursive: true, force: true });
}

test("plan attachment route serves a managed image inline", async t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-attachment-route-"));
  t.after(() => clean(roleDir));
  const content = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZsAAAAASUVORK5CYII=", "base64");
  const plan = createPlan(roleDir, {
    id: "plan-preview",
    title: "图片预览",
    focus: "图片预览",
    status: "暂停",
    steps: [{ id: "view", title: "查看图片", status: "未开始" }],
    keywords: ["图片"],
    attachments: [{ name: "preview.png", mimeType: "image/png", contentBase64: content.toString("base64") }]
  });
  const attachment = plan.attachments[0]!;
  const planFile = planJsonFile(roleDir, plan.id, "active");
  const stored = JSON.parse(fs.readFileSync(planFile, "utf8")) as { attachments: Array<{ kind: string }> };
  stored.attachments[0]!.kind = "file";
  fs.writeFileSync(planFile, JSON.stringify(stored, null, 2), "utf8");
  const response = await getAttachment(
    `/api/roles/Rabi/plans/${encodeURIComponent(plan.id)}/attachments/${encodeURIComponent(attachment.id)}`,
    roleDir
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "image/png");
  assert.match(String(response.headers["content-disposition"]), /^inline;/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(response.body(), content);
});

test("plan attachment route serves managed video inline with byte ranges", async t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-video-route-"));
  t.after(() => clean(roleDir));
  const content = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const plan = createPlan(roleDir, {
    id: "plan-video-preview",
    title: "视频预览",
    focus: "视频预览",
    status: "暂停",
    steps: [{ id: "view", title: "查看视频", status: "未开始" }],
    keywords: ["视频"],
    attachments: [{ name: "demo.mp4", mimeType: "video/mp4", contentBase64: content.toString("base64") }]
  });
  const attachment = plan.attachments[0]!;
  const response = await getAttachment(
    `/api/roles/Rabi/plans/${encodeURIComponent(plan.id)}/attachments/${encodeURIComponent(attachment.id)}`,
    roleDir,
    "bytes=4-7"
  );

  assert.equal(attachment.kind, "video");
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers["content-type"], "video/mp4");
  assert.match(String(response.headers["content-disposition"]), /^inline;/);
  assert.equal(response.headers["accept-ranges"], "bytes");
  assert.equal(response.headers["content-range"], `bytes 4-7/${content.byteLength}`);
  assert.deepEqual(response.body(), Buffer.from("ftyp"));
});

test("plan attachment route resolves copied plan data after the runtime root moves", async (t) => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-attachment-source-"));
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-attachment-target-"));
  t.after(() => clean(sourceRoot));
  t.after(() => clean(targetRoot));
  const sourceRoleDir = path.join(sourceRoot, "roles", "Rabi");
  const targetRoleDir = path.join(targetRoot, "roles", "Rabi");
  fs.mkdirSync(sourceRoleDir, { recursive: true });
  const content = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZsAAAAASUVORK5CYII=", "base64");
  const plan = createPlan(sourceRoleDir, {
    id: "plan-relocated-preview",
    title: "迁移后的图片预览",
    focus: "迁移后的图片预览",
    status: "暂停",
    steps: [{ id: "view", title: "查看图片", status: "未开始" }],
    keywords: ["图片"],
    attachments: [{ name: "preview.png", mimeType: "image/png", contentBase64: content.toString("base64") }]
  });
  const attachment = plan.attachments[0]!;
  fs.mkdirSync(path.dirname(targetRoleDir), { recursive: true });
  fs.cpSync(sourceRoleDir, targetRoleDir, { recursive: true });
  clean(sourceRoot);

  const pathname = `/api/roles/Rabi/plans/${encodeURIComponent(plan.id)}/attachments/${encodeURIComponent(attachment.id)}`;
  const response = await getAttachment(pathname, targetRoleDir);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body(), content);

  const relocatedFile = path.join(
    path.dirname(planJsonFile(targetRoleDir, plan.id, "active")),
    "attachments",
    path.basename(attachment.path)
  );
  const changed = Buffer.from(content);
  changed[changed.byteLength - 1] ^= 0xff;
  fs.writeFileSync(relocatedFile, changed);
  const rejected = await getAttachment(pathname, targetRoleDir);
  assert.equal(rejected.statusCode, 404);
});

test("plan attachment route returns 404 for missing or unmanaged paths", async t => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-attachment-guard-"));
  t.after(() => clean(roleDir));
  const sourceFile = path.join(roleDir, "source.txt");
  fs.writeFileSync(sourceFile, "inside", "utf8");
  const plan = createPlan(roleDir, {
    id: "plan-guard",
    title: "附件路径门禁",
    focus: "附件路径门禁",
    status: "暂停",
    steps: [{ id: "guard", title: "检查路径", status: "未开始" }],
    keywords: ["附件"],
    attachments: [{ path: sourceFile }]
  });
  const missing = await getAttachment(`/api/roles/Rabi/plans/${plan.id}/attachments/missing`, roleDir);
  assert.equal(missing.statusCode, 404);

  const outside = path.join(roleDir, "outside.txt");
  fs.writeFileSync(outside, "outside", "utf8");
  const planFile = planJsonFile(roleDir, plan.id, "active");
  const stored = JSON.parse(fs.readFileSync(planFile, "utf8")) as { attachments: Array<{ path: string }> };
  stored.attachments[0]!.path = outside;
  fs.writeFileSync(planFile, JSON.stringify(stored, null, 2), "utf8");
  const guarded = await getAttachment(
    `/api/roles/Rabi/plans/${plan.id}/attachments/${plan.attachments[0]!.id}`,
    roleDir
  );
  assert.equal(guarded.statusCode, 404);
  assert.notDeepEqual(guarded.body(), Buffer.from("outside"));
});
