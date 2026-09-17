import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listAntigravityDeliveries,
  notifyAntigravity,
  resetAntigravityDeliveriesForTest,
  type AntigravityBridgeDependencies
} from "./antigravityRuntime.js";
import type { AntigravityEnvironment } from "./antigravityBridge.js";
import type { AntigravityReceipt } from "./antigravityReceipt.js";

const ENVIRONMENT: AntigravityEnvironment = {
  lsAddress: "127.0.0.1:7300",
  csrfToken: "token",
  projectId: "outside-of-project"
};

const NO_RECEIPT: AntigravityReceipt = {
  found: false,
  stepIndex: null,
  source: null,
  totalSteps: 0,
  modelReplied: false,
  modelText: null,
  reason: "not read"
};

/**
 * Keep the runtime tests from touching the real adapter log by pointing the
 * history directory at a throwaway path for the life of each test.
 */
function withIsolatedHistory<T>(run: () => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-runtime-"));
  const previous = process.env.RABIROUTE_DATA_DIR;
  process.env.RABIROUTE_DATA_DIR = root;
  return run().finally(() => {
    if (previous === undefined) delete process.env.RABIROUTE_DATA_DIR;
    else process.env.RABIROUTE_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("a delivery records accepted-to-delivered with a readable receipt", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    const calls: string[] = [];
    const dependencies: AntigravityBridgeDependencies = {
      resolveEnvironment: async () => ENVIRONMENT,
      deliverPrompt: async (request) => {
        calls.push(request.prompt);
        return { conversationId: "conv-1", kind: "new-conversation", raw: {} };
      },
      readTranscript: () => [],
      readReceipt: async () => ({ ...NO_RECEIPT, found: true, stepIndex: 0, source: "USER_EXPLICIT", reason: "recorded" })
    };

    const result = await notifyAntigravity("hello", dependencies);

    assert.deepEqual(calls, ["hello"]);
    assert.equal(result.record.status, "delivered");
    assert.equal(result.record.conversationId, "conv-1");
    assert.equal(result.record.receipt?.found, true);
    assert.equal(result.thread.id, "conv-1");
    assert.equal(listAntigravityDeliveries().length, 1);
  });
});

test("without a configured conversation the delivery starts a new one", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    const seen: Array<{ kind?: string; conversationId?: string }> = [];
    await notifyAntigravity("hello", {
      resolveEnvironment: async () => ENVIRONMENT,
      deliverPrompt: async (request) => {
        seen.push({ kind: request.kind, conversationId: request.conversationId });
        return { conversationId: "conv-new", kind: "new-conversation", raw: {} };
      },
      readTranscript: () => [],
      readReceipt: async () => NO_RECEIPT
    });
    assert.deepEqual(seen, [{ kind: "new-conversation", conversationId: undefined }]);
  });
});

test("a failed delivery is recorded before the error is rethrown", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    await assert.rejects(
      notifyAntigravity("hello", {
        resolveEnvironment: async () => { throw new Error("host is not running"); },
        deliverPrompt: async () => { throw new Error("unreachable"); },
        readTranscript: () => [],
        readReceipt: async () => NO_RECEIPT
      }),
      /host is not running/
    );
    const [record] = listAntigravityDeliveries();
    assert.equal(record?.status, "failed");
    assert.equal(record?.error, "host is not running");
    // A caller must be able to tell "never accepted" from "accepted then lost".
    assert.ok(record?.acceptedAt);
    assert.equal(record?.deliveredAt, undefined);
  });
});

test("an unreadable receipt does not fail a delivery that already happened", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    const result = await notifyAntigravity("hello", {
      resolveEnvironment: async () => ENVIRONMENT,
      deliverPrompt: async () => ({ conversationId: "conv-1", kind: "new-conversation", raw: {} }),
      readTranscript: () => [],
      readReceipt: async () => { throw new Error("transcript unreadable"); }
    });
    // The prompt reached the host, so the delivery status must stay delivered
    // even when the receipt could not be read back.
    assert.equal(result.record.status, "delivered");
    assert.equal(result.record.receipt, undefined);
  });
});

test("concurrent notifications are serialized so they cannot interleave", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    const order: string[] = [];
    const dependencies: AntigravityBridgeDependencies = {
      resolveEnvironment: async () => ENVIRONMENT,
      deliverPrompt: async (request) => {
        order.push(`start:${request.prompt}`);
        await new Promise((resolve) => { setTimeout(resolve, 25); });
        order.push(`end:${request.prompt}`);
        return { conversationId: `conv-${request.prompt}`, kind: "new-conversation", raw: {} };
      },
      readTranscript: () => [],
      readReceipt: async () => NO_RECEIPT
    };

    await Promise.all([
      notifyAntigravity("a", dependencies),
      notifyAntigravity("b", dependencies),
      notifyAntigravity("c", dependencies)
    ]);

    // Each delivery must fully finish before the next begins.
    assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    assert.equal(listAntigravityDeliveries().length, 3);
  });
});

test("a failed delivery does not stall the queue for later calls", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    let attempt = 0;
    const dependencies: AntigravityBridgeDependencies = {
      resolveEnvironment: async () => ENVIRONMENT,
      deliverPrompt: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient failure");
        return { conversationId: "conv-2", kind: "new-conversation", raw: {} };
      },
      readTranscript: () => [],
      readReceipt: async () => NO_RECEIPT
    };

    await assert.rejects(notifyAntigravity("first", dependencies), /transient failure/);
    const second = await notifyAntigravity("second", dependencies);
    assert.equal(second.record.status, "delivered");
    assert.deepEqual(listAntigravityDeliveries().map((record) => record.status), ["failed", "delivered"]);
  });
});

test("the delivery log is capped so long-running routes cannot grow without bound", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    const dependencies: AntigravityBridgeDependencies = {
      resolveEnvironment: async () => ENVIRONMENT,
      deliverPrompt: async () => ({ conversationId: "conv-1", kind: "new-conversation", raw: {} }),
      readTranscript: () => [],
      readReceipt: async () => NO_RECEIPT
    };
    for (let index = 0; index < 105; index += 1) {
      await notifyAntigravity(`message ${index}`, dependencies);
    }
    const records = listAntigravityDeliveries();
    assert.equal(records.length, 100);
    assert.equal(records[0]?.deliveryId !== records.at(-1)?.deliveryId, true);
  });
});

test("the pre-delivery step count is captured so a repeat send cannot reuse a receipt", async () => {
  await withIsolatedHistory(async () => {
    resetAntigravityDeliveriesForTest();
    const { config } = await import("./config.js");
    const previous = config.antigravityConversationId;
    // A configured conversation is what makes the runtime reuse an existing
    // session, and only that path needs the boundary.
    config.antigravityConversationId = "conv-1";
    let observedInitial: number | undefined;
    try {
      await notifyAntigravity("hello", {
        resolveEnvironment: async () => ENVIRONMENT,
        deliverPrompt: async (request) => {
          assert.equal(request.kind, "system-message");
          assert.equal(request.conversationId, "conv-1");
          return { conversationId: "conv-1", kind: "system-message", raw: {} };
        },
        // A transcript already holding two steps means the receipt must ignore
        // anything before index 2.
        readTranscript: () => [
          { stepIndex: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", createdAt: "", content: "x" },
          { stepIndex: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", createdAt: "", content: "y" }
        ],
        readReceipt: async (_conversationId, options) => {
          observedInitial = options.initialNumSteps;
          return NO_RECEIPT;
        }
      });
    } finally {
      config.antigravityConversationId = previous;
    }
    assert.equal(observedInitial, 2);
  });
});
