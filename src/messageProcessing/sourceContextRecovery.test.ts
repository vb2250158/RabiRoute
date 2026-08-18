import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendMessageContextToDir, recentMessageContextItems } from "../messageContextStore.js";
import type { MessageProcessingRequirement } from "./board.js";
import {
  loadMessageProcessingContext,
  recoverMessageProcessingSourceRecord,
  recoverReviewedMessageProcessingSourceRecord
} from "./sourceContextRecovery.js";

function requirement(sourceMessageId = "source-old"): MessageProcessingRequirement {
  return {
    id: "requirement-source-recovery",
    dedupeKey: "message-group:requirement-source-recovery",
    kind: "message_reply",
    replyPolicy: "required",
    status: "awaiting_send",
    source: {
      routeId: "route-main",
      routeProfileId: "route-main",
      roleId: "RoleMain",
      endpoint: "napcat",
      conversationKey: "napcat:gateway:route-main:instance:qq-main:group:798776701",
      sender: "user-1",
      routeKinds: ["group_message"],
      messageIds: [sourceMessageId],
      replyContext: {
        runtimeRouteId: "route-main",
        gatewayId: "route-main",
        routeProfileId: "route-main",
        groupId: 798776701,
        instanceId: "qq-main"
      }
    },
    messageGroupId: "message-group-b4f8",
    createdAt: "2026-08-14T01:55:03.569Z",
    updatedAt: "2026-08-14T01:55:03.569Z",
    dueAt: "2026-08-14T02:05:03.569Z"
  };
}

function writeFormalRecord(
  roleDir: string,
  values: Record<string, unknown> = {},
  append = false
): void {
  fs.writeFileSync(path.join(roleDir, "group-messages.jsonl"), `${JSON.stringify({
    time: 1,
    groupId: 798776701,
    userId: 10001,
    rawMessage: "较早但仍属于当前 requirement 的来源",
    messageId: "source-old",
    senderName: "user-1",
    instanceId: "qq-main",
    adapterType: "napcat",
    isSelf: false,
    ...values
  })}\n`, { encoding: "utf8", flag: append ? "a" : "w" });
}

test("an exact registered source beyond the recent window is recovered from formal group history", (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-context-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const conversationKey = "napcat:gateway:route-main:instance:qq-main:group:798776701";
  appendMessageContextToDir(roleDir, {
    time: 1,
    direction: "inbound",
    adapter: "napcat",
    channel: "napcat",
    conversationKey,
    sender: "user-1",
    target: "798776701",
    text: "较早但仍属于当前 requirement 的来源",
    messageId: "source-old"
  });
  for (let index = 0; index < 80; index += 1) {
    appendMessageContextToDir(roleDir, {
      time: index + 2,
      direction: "inbound",
      adapter: "napcat",
      channel: "napcat",
      conversationKey,
      sender: "user-2",
      target: "798776701",
      text: `较新的消息 ${index}`,
      messageId: `newer-${index}`
    });
  }
  writeFormalRecord(roleDir);

  const recent = recentMessageContextItems([roleDir], {
    conversationKey,
    limit: 80,
    maxChars: 24_000,
    includeArchives: true
  });
  assert.equal(recent.some((item) => String(item.messageId) === "source-old"), false);

  const recovered = loadMessageProcessingContext({
    roleDir,
    requirement: requirement(),
    sourceMessageId: "source-old"
  });

  assert.equal(recovered.filter((item) => String(item.messageId) === "source-old").length, 1);
  assert.equal(recovered.find((item) => String(item.messageId) === "source-old")?.target, "798776701");
});

test("formal group truth overrides a stale requirement conversationKey but must match the send target", (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-target-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  writeFormalRecord(roleDir);
  const stale = requirement();
  stale.source.conversationKey = "napcat:gateway:route-main:instance:qq-main:group:474222421";
  stale.source.replyContext = {
    runtimeRouteId: "route-main",
    gatewayId: "route-main",
    routeProfileId: "route-main",
    groupId: 474222421,
    instanceId: "qq-main"
  };

  const recovered = recoverMessageProcessingSourceRecord(roleDir, stale, "source-old", {
    expectedGroupId: "798776701",
    expectedInstanceId: "qq-main"
  });
  assert.equal(recovered.groupId, "798776701");
  assert.throws(
    () => recoverMessageProcessingSourceRecord(roleDir, stale, "source-old", {
      expectedGroupId: "474222421",
      expectedInstanceId: "qq-main"
    }),
    /formal group 798776701 does not match target group 474222421/i
  );
});

test("duplicate formal source records fail closed", (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-duplicate-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  writeFormalRecord(roleDir);
  writeFormalRecord(roleDir, { time: 2 }, true);
  assert.throws(
    () => recoverMessageProcessingSourceRecord(roleDir, requirement(), "source-old"),
    /formal group history contains 2 matching records/i
  );
});

test("configuration source 1242330522 cannot be redirected from formal group 474222421 to 798776701", (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-1242330522-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  writeFormalRecord(roleDir, {
    messageId: "1242330522",
    groupId: 474222421,
    rawMessage: "[CQ:image,file=config.png]"
  });
  const source124 = requirement("1242330522");
  source124.source.conversationKey = "napcat:gateway:route-main:instance:qq-main:group:474222421";
  source124.source.replyContext = {
    runtimeRouteId: "route-main",
    gatewayId: "route-main",
    routeProfileId: "route-main",
    groupId: 474222421,
    instanceId: "qq-main"
  };
  assert.throws(
    () => recoverMessageProcessingSourceRecord(roleDir, source124, "1242330522", {
      expectedGroupId: "798776701",
      expectedInstanceId: "qq-main"
    }),
    /formal group 474222421 does not match target group 798776701/i
  );
});

test("missing or conflicting formal Route evidence fails closed", (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-route-conflict-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  assert.throws(
    () => recoverMessageProcessingSourceRecord(roleDir, requirement(), "source-old"),
    /formal group history contains 0 matching records/i
  );
  writeFormalRecord(roleDir, { gatewayId: "route-other" });
  assert.throws(
    () => recoverMessageProcessingSourceRecord(roleDir, requirement(), "source-old"),
    /formal Route evidence conflicts with route-main/i
  );
});

test("reviewed recovery rejects image evidence that was not explicitly reviewed", (t) => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-source-image-review-"));
  t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
  const imagePath = path.join(roleDir, "napcat-media", "qq-main", "source-old", "01-image.png");
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50]));
  writeFormalRecord(roleDir, {
    rawMessage: "[CQ:image,file=01-image.png]",
    attachments: [{
      id: "source-old:image:1",
      kind: "image",
      name: "01-image.png",
      status: "ready",
      path: imagePath,
      sourceMessageId: "source-old"
    }]
  });
  const withImage = requirement();
  withImage.source.attachments = [{
    id: "source-old:image:1",
    messageId: "source-old",
    kind: "image",
    name: "01-image.png",
    status: "ready",
    path: imagePath
  }];
  withImage.sourceEvidenceReview = {
    reviewedMessageIds: ["source-old"],
    replyChainChecked: true,
    attachmentReviews: [{
      attachmentId: "source-old:image:1",
      status: "unavailable",
      observation: "未能读取"
    }],
    evidence: "已核对来源消息",
    reviewedAt: "2026-08-14T02:00:00.000Z"
  };

  assert.throws(
    () => recoverReviewedMessageProcessingSourceRecord(roleDir, withImage, "source-old", {
      expectedGroupId: "798776701",
      expectedInstanceId: "qq-main"
    }),
    /attachment source-old:image:1.*not reviewed/i
  );
  withImage.sourceEvidenceReview.attachmentReviews[0]!.status = "reviewed";
  assert.equal(
    recoverReviewedMessageProcessingSourceRecord(roleDir, withImage, "source-old", {
      expectedGroupId: "798776701",
      expectedInstanceId: "qq-main"
    }).reviewedAttachmentIds[0],
    "source-old:image:1"
  );
});
