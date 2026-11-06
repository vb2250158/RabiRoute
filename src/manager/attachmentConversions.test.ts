import { nativeHttpTestFetch } from "./nativeHttpTestClient.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import { withTestEndpointEgress } from "../endpointEgress.fixture.js";
import { deliverCompletionToEndpoint } from "./agentCompletionDelivery.js";
import { normalizeAgentCompletionDeliveries } from "../shared/agentHookAutomation.js";

test("attachment conversion flags round-trip booleans and retain legacy default-on behavior", () => {
  const base = { id: "rule", enabled: true, event: "task_completed", conditions: [], destination: { channel: "napcat", gatewayId: "route", params: { target: "group", targetId: "123", instanceId: "qq" } } };
  for (const value of [false, "false", true, "true"]) {
    const [rule] = normalizeAgentCompletionDeliveries([{ ...base, destination: { ...base.destination, params: { ...base.destination.params,
      markdownFilesAsImages: value, imageFilesAsImages: value, htmlFilesAsLinks: value } } }]);
    assert.equal(rule.destination.params.markdownFilesAsImages, String(value));
    assert.equal(rule.destination.params.imageFilesAsImages, String(value));
    assert.equal(rule.destination.params.htmlFilesAsLinks, String(value));
    assert.deepEqual(normalizeAgentCompletionDeliveries([rule]), [rule]);
  }
  assert.equal(normalizeAgentCompletionDeliveries([base])[0].destination.params.htmlFilesAsLinks, undefined);
});

test("default attachment conversions send MD/images inline and HTML as a link, freeze payloads and isolate a missing file", async t => {
  t.mock.method(globalThis, "fetch", nativeHttpTestFetch);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-attachment-conversion-"));
  const calls: Array<{ url: string; body: any }> = [];
  const server = http.createServer((req, res) => { let body = ""; req.on("data", chunk => body += chunk); req.on("end", () => {
    calls.push({ url: req.url!, body: JSON.parse(body) }); res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", retcode: 0, data: req.url?.includes("upload") ? { file_id: "file-" + calls.length } : { message_id: calls.length } }));
  }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const md = path.join(rootDir, "说明.md"), image = path.join(rootDir, "效果.png"), html = path.join(rootDir, "report.html"), missing = path.join(rootDir, "missing.md");
  fs.writeFileSync(path.join(rootDir, "figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="#25a56a"/><text x="20" y="70" font-size="28">Attachment figure</text></svg>');
  fs.writeFileSync(md, "# 验收报告\n\n| 名称 | 结果 |\n|---|---|\n| 附件 | **通过** |\n\n![附件配图](./figure.svg)\n\n```mermaid\nflowchart LR\n A[附件] --> B[图片]\n```\n");
  fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64"));
  fs.writeFileSync(html, "<!doctype html><h1>报告</h1>");
  let published = 0;
  const options = withTestEndpointEgress({ rootDir, routeRoot: path.join(rootDir, "data/route"), rolesRoot: path.join(rootDir, "data/roles"),
    publishHtmlAttachment: async () => { published++; return "https://example.test/share/123#key"; },
    runtimes: [{ id: "route", enabled: true, napcatInstances: [{ id: "qq", enabled: true, httpUrl: `http://127.0.0.1:${address.port}`, accessToken: "" }] }] });
  const rule = { id: "rule", enabled: true, event: "task_completed", conditions: [], destination: { channel: "napcat", gatewayId: "route", params: { target: "group", targetId: "123", instanceId: "qq" } } };
  const hook = { eventName: "Stop" as const, sessionId: "attachment-test", turnId: "turn", lastAssistantMessage: `[MD](<${md}>) [missing](<${missing}>) [image](<${image}>) [HTML](<${html}>)` };
  try {
    await assert.rejects(deliverCompletionToEndpoint(rule, hook, "conversion-default", "route", options), /部分附件未确认/);
    assert.equal(calls.length, 4, "body plus three successful transformed attachments");
    assert.equal(calls.some(call => call.url.includes("upload")), false);
    assert.match(JSON.stringify(calls[1].body), /base64:\/\/iVBOR/);
    const sentImage = calls[2].body.message.find((segment: any) => segment.type === "image").data.file;
    assert.match(sentImage, /completion-attachments/); assert.deepEqual(fs.readFileSync(sentImage), fs.readFileSync(image));
    assert.match(JSON.stringify(calls[3].body), /https:\/\/example.test\/share\/123#key/);
    const count = calls.length;
    fs.unlinkSync(md); fs.unlinkSync(image); fs.unlinkSync(html);
    await assert.rejects(deliverCompletionToEndpoint(rule, hook, "conversion-default", "route", options), /部分附件未确认/);
    assert.equal(calls.length, count, "readback of frozen payloads must not repeat sends or require original files");
    assert.equal(published, 1);
    const frozenImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
    const native = `base64://${frozenImage.toString("base64")}`;
    fs.writeFileSync(image, frozenImage);
    const beforeNative = calls.length;
    await deliverCompletionToEndpoint(rule, { ...hook, lastAssistantMessage: `[image](<${image}>)` }, "native-image-once", "route", options, { plans: [], images: [native] });
    assert.equal(calls.length, beforeNative + 1, "a native image plus its normal file link produces only one visible image");
    const beforeEmbedded = calls.length;
    await deliverCompletionToEndpoint(rule, { ...hook, lastAssistantMessage: `![预览](<${image}>) [下载](<${image}>)` }, "linked-image-once", "route", options);
    assert.equal(calls.length, beforeEmbedded + 1, "a Markdown image plus its normal file link must not send a second image");
    const id = "prepared-before-send", fileId = `${id}-file-${createHash("sha256").update(process.platform === "win32" ? image.toLowerCase() : image).digest("hex")}`;
    const prepared = path.join(rootDir, "data/completion-attachments", createHash("sha256").update(fileId).digest("hex") + ".json");
    const snapshot = prepared.replace(/\.json$/, ".png"); fs.writeFileSync(snapshot, frozenImage);
    fs.writeFileSync(prepared, JSON.stringify({ type: "image", path: snapshot })); fs.unlinkSync(image);
    await deliverCompletionToEndpoint(rule, { ...hook, lastAssistantMessage: `[image](<${image}>)` }, id, "route", options);
    assert.equal(calls.at(-1)?.body.message.find((segment: any) => segment.type === "image").data.file, snapshot);
    assert.deepEqual(fs.readFileSync(snapshot), frozenImage, "prepared image bytes survive source deletion before the first platform send");
    const gif = path.join(rootDir, "animation.gif"), gifBytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"); fs.writeFileSync(gif, gifBytes);
    await deliverCompletionToEndpoint(rule, { ...hook, lastAssistantMessage: `[GIF](<${gif}>)` }, "gif-inline", "route", options);
    const gifSnapshot = calls.at(-1)?.body.message.find((segment: any) => segment.type === "image").data.file;
    assert.match(gifSnapshot, /\.gif$/); assert.deepEqual(fs.readFileSync(gifSnapshot), gifBytes, "animated image bytes retain their original format");
    const noImageConversion = { ...rule, destination: { ...rule.destination, params: { ...rule.destination.params, imageFilesAsImages: "false" } } };
    await deliverCompletionToEndpoint(noImageConversion, { ...hook, lastAssistantMessage: `[GIF](<${gif}>)` }, "gif-file", "route", options);
    assert.equal(calls.at(-1)?.url, "/upload_group_file"); assert.equal(calls.at(-1)?.body.file, gif);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(rootDir, { recursive: true, force: true }); }
});
