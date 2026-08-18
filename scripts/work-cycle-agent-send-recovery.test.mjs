import assert from "node:assert/strict";
import test from "node:test";
import { sendWorkCycleAgentReplyWithRecovery } from "./work-cycle-agent-send-recovery.mjs";

test("work-cycle retries one identical payload after receipt readback confirms missing", async () => {
  const payload = { deliveryId: "work-cycle-referenced-test", payload: { type: "text", text: "same payload" } };
  const posts = [];
  const result = await sendWorkCycleAgentReplyWithRecovery({
    deliveryId: payload.deliveryId,
    payload,
    post: async (value) => {
      posts.push(structuredClone(value));
      return posts.length === 1
        ? { response: null, parsed: null, error: new Error("Manager unavailable") }
        : { response: { status: 202 }, parsed: { status: "sent", sentMessageId: "qq-recovered-1", idempotency: { state: "completed" } }, error: null };
    },
    readReceipt: async () => ({ response: { status: 404 }, parsed: { idempotency: { state: "missing" } }, error: null }),
    wait: async () => undefined
  });

  assert.equal(result.sentMessageId, "qq-recovered-1");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], posts[0]);
});

test("work-cycle does not replay an uncertain delivery", async () => {
  let posts = 0;
  await assert.rejects(sendWorkCycleAgentReplyWithRecovery({
    deliveryId: "work-cycle-referenced-uncertain",
    payload: { deliveryId: "work-cycle-referenced-uncertain", payload: { type: "text", text: "same payload" } },
    post: async () => {
      posts += 1;
      return { response: null, parsed: null, error: new Error("Manager unavailable") };
    },
    readReceipt: async () => ({ response: { status: 409 }, parsed: { idempotency: { state: "uncertain" } }, error: null }),
    wait: async () => undefined
  }), /uncertain; do not resend automatically/);
  assert.equal(posts, 1);
});

test("work-cycle never performs a second missing retry", async () => {
  let posts = 0;
  await assert.rejects(sendWorkCycleAgentReplyWithRecovery({
    deliveryId: "work-cycle-referenced-missing-twice",
    payload: { deliveryId: "work-cycle-referenced-missing-twice", payload: { type: "text", text: "same payload" } },
    post: async () => {
      posts += 1;
      return { response: null, parsed: null, error: new Error("Manager unavailable") };
    },
    readReceipt: async () => ({ response: { status: 404 }, parsed: { idempotency: { state: "missing" } }, error: null }),
    wait: async () => undefined,
    receiptAttempts: 1
  }), /missing after one bounded retry/);
  assert.equal(posts, 2);
});

test("work-cycle does not treat an unstructured HTTP 404 as authoritative missing", async () => {
  let posts = 0;
  await assert.rejects(sendWorkCycleAgentReplyWithRecovery({
    deliveryId: "work-cycle-referenced-proxy-404",
    payload: { deliveryId: "work-cycle-referenced-proxy-404", payload: { type: "text", text: "same payload" } },
    post: async () => {
      posts += 1;
      return { response: null, parsed: null, error: new Error("Manager unavailable") };
    },
    readReceipt: async () => ({ response: { status: 404 }, parsed: { raw: "not found" }, error: null }),
    wait: async () => undefined,
    receiptAttempts: 1
  }), /uncertain; do not resend automatically/);
  assert.equal(posts, 1);
});
