import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  executeIdempotentAgentReply,
  readAgentReplyReceipt
} from "./agentReplyIdempotency.js";

function temporaryRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-agent-reply-idempotency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("concurrent callers with one deliveryId execute the reply only once", async (t) => {
  const rootDir = temporaryRoot(t);
  let calls = 0;
  const request = {
    deliveryId: "work-cycle-inquiry-plan-one-cycle-one",
    text: "[CQ:at,qq=10001] Please provide the build contract.",
    replyContext: { targetType: "group", groupId: "20001", proactive: true }
  };
  const deliver = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { ok: true, status: "sent" as const, sentMessageId: "30001" };
  };

  const results = await Promise.all(Array.from({ length: 8 }, () =>
    executeIdempotentAgentReply(request, { rootDir, deliver })
  ));

  assert.equal(calls, 1);
  assert.equal(results.filter((item) => item.body.idempotency?.duplicate === false).length, 1);
  assert.equal(results.filter((item) => item.body.idempotency?.duplicate === true).length, 7);
  assert.ok(results.every((item) => item.body.sentMessageId === "30001"));
});

test("a completed reply is recovered after caller response loss and process restart", async (t) => {
  const rootDir = temporaryRoot(t);
  let calls = 0;
  const request = {
    deliveryId: "work-cycle-inquiry-plan-two-cycle-one",
    text: "[CQ:at,qq=10002] Please provide the owner.",
    replyContext: { targetType: "group", groupId: "20002", proactive: true }
  };

  await executeIdempotentAgentReply(request, {
    rootDir,
    deliver: async () => {
      calls += 1;
      return { ok: true, status: "sent", sentMessageId: "30002" };
    }
  });

  const recovered = readAgentReplyReceipt(rootDir, request.deliveryId);
  assert.equal(recovered?.state, "completed");
  assert.equal(recovered?.result?.sentMessageId, "30002");

  const replay = await executeIdempotentAgentReply(request, {
    rootDir,
    deliver: async () => {
      calls += 1;
      return { ok: true, status: "sent", sentMessageId: "unexpected" };
    }
  });
  assert.equal(calls, 1);
  assert.equal(replay.body.sentMessageId, "30002");
  assert.equal(replay.body.idempotency?.duplicate, true);
});

test("the same deliveryId rejects changed payloads without sending", async (t) => {
  const rootDir = temporaryRoot(t);
  let calls = 0;
  const base = {
    deliveryId: "work-cycle-inquiry-plan-three-cycle-one",
    text: "[CQ:at,qq=10003] First question.",
    replyContext: { targetType: "group", groupId: "20003", proactive: true }
  };
  await executeIdempotentAgentReply(base, {
    rootDir,
    deliver: async () => {
      calls += 1;
      return { ok: true, status: "sent", sentMessageId: "30003" };
    }
  });

  const conflict = await executeIdempotentAgentReply({ ...base, text: "Changed question." }, {
    rootDir,
    deliver: async () => {
      calls += 1;
      return { ok: true, status: "sent", sentMessageId: "unexpected" };
    }
  });
  assert.equal(calls, 1);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.idempotency?.state, "conflict");
});

test("an uncertain execution is persisted and never auto-replayed", async (t) => {
  const rootDir = temporaryRoot(t);
  let calls = 0;
  const request = {
    deliveryId: "work-cycle-inquiry-plan-four-cycle-one",
    text: "[CQ:at,qq=10004] Question with uncertain transport.",
    replyContext: { targetType: "group", groupId: "20004", proactive: true }
  };
  const first = await executeIdempotentAgentReply(request, {
    rootDir,
    deliver: async () => {
      calls += 1;
      throw new Error("connection closed after request body was accepted");
    }
  });
  assert.equal(first.statusCode, 503);
  assert.equal(first.body.idempotency?.state, "uncertain");

  const replay = await executeIdempotentAgentReply(request, {
    rootDir,
    deliver: async () => {
      calls += 1;
      return { ok: true, status: "sent", sentMessageId: "unexpected" };
    }
  });
  assert.equal(calls, 1);
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.body.idempotency?.state, "uncertain");
});
