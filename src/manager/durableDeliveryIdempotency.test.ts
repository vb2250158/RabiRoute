import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeDurableDelivery, readDurableDeliveryReceipt } from "./durableDeliveryIdempotency.js";

test("durable delivery recovery completes from accepted readback and reloads without replay", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-recovery-"));
  let sends = 0;
  const options = {
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "12345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    deliver: async () => { sends += 1; throw new Error("Desktop request timed out"); },
    recover: async () => ({ state: "completed" as const, result: { accepted: true } })
  };
  const first = await executeDurableDelivery(options);
  const reloaded = await executeDurableDelivery(options);
  assert.equal(first.state, "completed");
  assert.equal(reloaded.state, "completed");
  assert.equal(sends, 1);
  assert.equal(readDurableDeliveryReceipt(rootDir, options.namespace, options.deliveryId)?.state, "completed");
});

test("durable delivery retries only once when authoritative readback says missing", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-missing-"));
  let sends = 0;
  const outcome = await executeDurableDelivery({
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "22345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    deliver: async () => {
      sends += 1;
      if (sends === 1) throw new Error("Desktop request timed out");
      return { accepted: true };
    },
    recover: async () => ({ state: "retry" as const })
  });
  assert.equal(outcome.state, "completed");
  assert.equal(sends, 2);
});

test("durable delivery keeps in-progress pending and uncertain terminal without replay", async () => {
  for (const state of ["in_progress", "uncertain"] as const) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `rabiroute-durable-${state}-`));
    let sends = 0;
    const outcome = await executeDurableDelivery({
      rootDir,
      namespace: "message-requirement-delivery",
      deliveryId: state === "in_progress" ? "32345678-1234-4567-8123-123456789abc" : "42345678-1234-4567-8123-123456789abc",
      payload: { batch: 1 },
      deliver: async () => { sends += 1; throw new Error("Desktop request timed out"); },
      recover: async () => ({ state, reason: state })
    });
    assert.equal(outcome.state, state);
    assert.equal(sends, 1);
  }
});

test("a new instance authoritatively recovers an earlier sending receipt without replay", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-reload-sending-"));
  let sends = 0;
  const base = {
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "52345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    waitForCompletionMs: 0,
    deliver: async () => { sends += 1; throw new Error("Desktop request timed out"); }
  };
  const pending = await executeDurableDelivery({
    ...base,
    recover: async () => ({ state: "in_progress" as const, reason: "still active" })
  });
  const recovered = await executeDurableDelivery({
    ...base,
    recover: async () => ({ state: "completed" as const, result: { accepted: true } })
  });
  assert.equal(pending.state, "in_progress");
  assert.equal(recovered.state, "completed");
  assert.equal(sends, 1);
});

test("a new instance retries an earlier sending receipt once after authoritative missing readback", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-durable-reload-missing-"));
  let sends = 0;
  const base = {
    rootDir,
    namespace: "message-requirement-delivery",
    deliveryId: "62345678-1234-4567-8123-123456789abc",
    payload: { batch: 1 },
    waitForCompletionMs: 0
  };
  const pending = await executeDurableDelivery({
    ...base,
    deliver: async () => {
      sends += 1;
      throw new Error("Desktop request timed out");
    },
    recover: async () => ({ state: "in_progress" as const, reason: "still active" })
  });
  const recovered = await executeDurableDelivery({
    ...base,
    deliver: async () => {
      sends += 1;
      return { accepted: true };
    },
    recover: async () => ({ state: "retry" as const })
  });

  assert.equal(pending.state, "in_progress");
  assert.equal(recovered.state, "completed");
  assert.equal(sends, 2);
  assert.equal(readDurableDeliveryReceipt(rootDir, base.namespace, base.deliveryId)?.state, "completed");
});
