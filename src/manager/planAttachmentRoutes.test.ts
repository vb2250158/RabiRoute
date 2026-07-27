import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { once } from "node:events";
import test from "node:test";
import { createPlan } from "../roleKnowledge.js";
import { handlePlanAttachmentApi } from "./planAttachmentRoutes.js";

class MockResponse extends Writable {
  statusCode = 0;
  headers: http.OutgoingHttpHeaders = {};
  readonly chunks: Buffer[] = [];

  writeHead(statusCode: number, headers: http.OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

async function getAttachment(pathname: string, roleDir: string, range?: string): Promise<MockResponse> {
  const request = { method: "GET", headers: range ? { range } : {} } as http.IncomingMessage;
  const response = new MockResponse();
  const finished = once(response, "finish");
  assert.equal(handlePlanAttachmentApi(request, pathname, response as unknown as http.ServerResponse, () => roleDir), true);
  await finished;
  return response;
}

test("plan attachment route serves a managed image inline", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-attachment-route-"));
  const content = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZsAAAAASUVORK5CYII=", "base64");
  const plan = createPlan(roleDir, {
    id: "plan-preview",
    title: "图片预览",
    focus: "图片预览",
    steps: [{ id: "view", title: "查看图片", status: "未开始" }],
    keywords: ["图片"],
    attachments: [{ name: "preview.png", mimeType: "image/png", contentBase64: content.toString("base64") }]
  });
  const attachment = plan.attachments[0]!;
  const planFile = path.join(roleDir, "plans", "items", "active", `${plan.id}.json`);
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

test("plan attachment route serves managed video inline with byte ranges", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-video-route-"));
  const content = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const plan = createPlan(roleDir, {
    id: "plan-video-preview",
    title: "视频预览",
    focus: "视频预览",
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

test("plan attachment route returns 404 for missing or unmanaged paths", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-plan-attachment-guard-"));
  const sourceFile = path.join(roleDir, "source.txt");
  fs.writeFileSync(sourceFile, "inside", "utf8");
  const plan = createPlan(roleDir, {
    id: "plan-guard",
    title: "附件路径门禁",
    focus: "附件路径门禁",
    steps: [{ id: "guard", title: "检查路径", status: "未开始" }],
    keywords: ["附件"],
    attachments: [{ path: sourceFile }]
  });
  const missing = await getAttachment(`/api/roles/Rabi/plans/${plan.id}/attachments/missing`, roleDir);
  assert.equal(missing.statusCode, 404);

  const outside = path.join(roleDir, "outside.txt");
  fs.writeFileSync(outside, "outside", "utf8");
  const planFile = path.join(roleDir, "plans", "items", "active", `${plan.id}.json`);
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
