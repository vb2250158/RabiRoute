import assert from "node:assert/strict";
import test from "node:test";
import {
  hasEffectiveProgress,
  isCompletePangHuProgressReceipt,
  isPangHuWorkspace,
  pangHuProgressMessage,
  stablePangHuProgressDeliveryId
} from "./panghuProgressNotificationGate.js";

test("PangHu progress scope accepts only configured formal workspaces", () => {
  assert.equal(isPangHuWorkspace("C:\\Data\\CottonProject\\PangHu"), true);
  assert.equal(isPangHuWorkspace("C:\\Data\\CottonProject\\PangHu\\Assets"), true);
  assert.equal(isPangHuWorkspace("C:\\Data\\CottonProject\\Other"), false);
});

test("effective progress excludes unchanged polling but keeps read-only findings", () => {
  assert.equal(hasEffectiveProgress("只读调查已核对真实 Hook、Outbox 和平台回执。"), true);
  assert.equal(hasEffectiveProgress("重复轮询，无变化。"), false);
  assert.equal(hasEffectiveProgress("ping"), false);
});

test("progress receipt requires Outbox sentMessageId and platform reference readback", () => {
  assert.equal(isCompletePangHuProgressReceipt({ status: "sent", sentMessageId: "m1", platformReferenceReadback: true }), true);
  assert.equal(isCompletePangHuProgressReceipt({ status: "sent", sentMessageId: "m1", platformReferenceReadback: false }), false);
  assert.equal(isCompletePangHuProgressReceipt({ status: "sent", platformReferenceReadback: true }), false);
});

test("progress delivery IDs are stable and message has no internal identifiers", () => {
  assert.equal(stablePangHuProgressDeliveryId("p", "s", "t"), stablePangHuProgressDeliveryId("p", "s", "t"));
  const message = pangHuProgressMessage({
    roleId: "XinghaiBuilder",
    roleDir: "C:\\Data\\CottonProject\\RabiRoute",
    plan: { id: "p", title: "计划", focus: "计划", status: "执行中", archiveStatus: "未归档", attachments: [], steps: [], updatedAt: "", createdAt: "", keywords: [], nextAction: "继续验证" },
    issue: { groupId: "example-managed-group", sourceMessageId: "source", module: "调查", summary: "回执链" },
    sourceSessionId: "session",
    sourceTurnId: "turn",
    finalMessage: "已确认 Stop Hook 会拦截未完成回执。"
  });
  assert.match(message, /【调查\/回执链】/);
  assert.doesNotMatch(message, /session|turn|source/);
});
