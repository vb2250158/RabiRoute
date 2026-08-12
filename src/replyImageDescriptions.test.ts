import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveReplyImageDescriptions,
  prepareReplyImageDescriptions,
  type ReplyImageDescriptionSend
} from "./replyImageDescriptions.js";
import type { AgentReplyOptions } from "./outbox.js";

function fixture(t: test.TestContext, options: { unavailable?: boolean; imageCount?: number } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-reply-image-description-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const routeDataDir = path.join(rootDir, "data", "route", "route-main");
  const mediaDir = path.join(routeDataDir, "napcat-media", "qq-main", "source-1");
  fs.mkdirSync(mediaDir, { recursive: true });
  const imageCount = options.imageCount ?? 2;
  const attachments = Array.from({ length: imageCount }, (_, index) => {
    const imagePath = path.join(mediaDir, `${String(index + 1).padStart(2, "0")}-image-${index + 1}.png`);
    if (!options.unavailable) fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, index]));
    return {
      id: `source-1:image:${index + 1}`,
      kind: "image",
      name: `image-${index + 1}.png`,
      status: options.unavailable ? "unavailable" : "ready",
      path: options.unavailable ? undefined : imagePath,
      sourceMessageId: "source-1"
    };
  });
  fs.writeFileSync(path.join(routeDataDir, "group-messages.jsonl"), `${JSON.stringify({
    time: 1,
    messageId: "source-1",
    groupId: 456,
    userId: 789,
    instanceId: "qq-main",
    adapterType: "napcat",
    rawMessage: Array.from({ length: imageCount }, (_, index) => `[CQ:image,file=image-${index + 1}.png]`).join(""),
    attachments
  })}\n`, "utf8");
  const replyOptions: AgentReplyOptions = {
    rootDir,
    routeRoot: path.join(rootDir, "data", "route"),
    rolesRoot: path.join(rootDir, "data", "roles"),
    runtimes: [{
      id: "route-main",
      enabled: true,
      dataDir: routeDataDir,
      napcatInstances: [{ id: "qq-main", httpUrl: "http://127.0.0.1:1", accessToken: "", enabled: true }]
    }]
  };
  return { rootDir, routeDataDir, mediaDir, replyOptions };
}

function send(replyImageDescriptions?: string[]): ReplyImageDescriptionSend {
  return {
    deliveryId: "delivery-image-review-1",
    sender: { agentType: "message_processing", sessionId: "thread-message-agent-1" },
    routeId: "route-main",
    channel: "napcat",
    target: {
      target: "group",
      groupId: "456",
      instanceId: "qq-main",
      replyToMessageId: "source-1"
    },
    replyImageDescriptions: replyImageDescriptions ?? []
  };
}

test("a quoted image message requires one concrete description per image", (t) => {
  const { replyOptions } = fixture(t);
  assert.throws(
    () => prepareReplyImageDescriptions(send(), replyOptions),
    /params\.replyImageDescriptions must contain 2 descriptions.*one for each image/i
  );
  assert.throws(
    () => prepareReplyImageDescriptions(send(["已查看", "第二张展示设置后的动态文字底框"]), replyOptions),
    /replyImageDescriptions\[0\].*actual image content and meaning/i
  );
  assert.throws(
    () => prepareReplyImageDescriptions(send(["第一张展示文字底框"]), replyOptions),
    /must contain 2 descriptions/i
  );
});

test("unavailable quoted images block the reply instead of accepting a guessed description", (t) => {
  const { replyOptions } = fixture(t, { unavailable: true, imageCount: 1 });
  assert.throws(
    () => prepareReplyImageDescriptions(send(["猜测这是一张界面截图"]), replyOptions),
    /referenced image 1.*not readable.*cannot send a reply based on a guessed description/i
  );
});

test("an unknown quoted message fails closed because its image count cannot be checked", (t) => {
  const { replyOptions } = fixture(t, { imageCount: 0 });
  const input = send([]);
  input.target.replyToMessageId = "missing-source";
  assert.throws(
    () => prepareReplyImageDescriptions(input, replyOptions),
    /referenced QQ message missing-source was not found.*cannot verify whether it contains images/i
  );
});

test("successful image review creates one same-name Markdown description beside each image", (t) => {
  const { rootDir, mediaDir, replyOptions } = fixture(t);
  const plan = prepareReplyImageDescriptions(send([
    "第一张展示动态文字较短时底框保持紧凑，并保留图标和文字间距。",
    "第二张展示文字变长后底框随内容扩展，图片想说明背景宽度需要动态适配。"
  ]), replyOptions);
  assert.ok(plan);
  const archive = archiveReplyImageDescriptions(plan!, {
    rootDir,
    sentMessageId: "qq-sent-7788"
  });

  assert.equal(archive.sourceMessageId, "source-1");
  assert.equal(archive.files.length, 2);
  const firstMarkdown = path.join(mediaDir, "01-image-1.md");
  const secondMarkdown = path.join(mediaDir, "02-image-2.md");
  assert.ok(fs.existsSync(firstMarkdown));
  assert.ok(fs.existsSync(secondMarkdown));
  assert.match(fs.readFileSync(firstMarkdown, "utf8"), /第一张展示动态文字较短时底框保持紧凑/);
  assert.match(fs.readFileSync(firstMarkdown, "utf8"), /thread-message-agent-1/);
  assert.match(fs.readFileSync(firstMarkdown, "utf8"), /qq-sent-7788/);
  assert.match(fs.readFileSync(secondMarkdown, "utf8"), /背景宽度需要动态适配/);
  assert.deepEqual(archive.files.map((item) => item.descriptionFile), [
    "data/route/route-main/napcat-media/qq-main/source-1/01-image-1.md",
    "data/route/route-main/napcat-media/qq-main/source-1/02-image-2.md"
  ]);

  archiveReplyImageDescriptions(plan!, { rootDir, sentMessageId: "qq-sent-7788" });
  assert.equal(fs.readFileSync(firstMarkdown, "utf8").match(/delivery-image-review-1/g)?.length, 1);
});

test("an unquoted send does not require or archive image descriptions", (t) => {
  const { replyOptions } = fixture(t);
  const input = send([]);
  input.target.replyToMessageId = "";
  assert.equal(prepareReplyImageDescriptions(input, replyOptions), undefined);
});
