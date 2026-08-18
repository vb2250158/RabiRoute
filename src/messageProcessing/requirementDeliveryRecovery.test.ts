import assert from "node:assert/strict";
import test from "node:test";
import { deliverRequirementBatchWithRecovery } from "./requirementDeliveryRecovery.js";

test("requirement delivery timeout reuses accepted or completed readback without retrying", async () => {
  for (const state of ["accepted", "completed"] as const) {
    let attempts = 0;
    const result = await deliverRequirementBatchWithRecovery({
      deliveryId: `delivery-${state}`,
      deliver: async () => { attempts += 1; throw new Error("thread-follower-steer-turn-timeout"); },
      readback: async () => ({ state })
    });
    assert.equal(result.state, state);
    assert.equal(attempts, 1);
  }
});

test("requirement delivery timeout waits on in-progress and preserves uncertain without retrying", async () => {
  for (const state of ["in_progress", "uncertain"] as const) {
    let attempts = 0;
    const result = await deliverRequirementBatchWithRecovery({
      deliveryId: `delivery-${state}`,
      deliver: async () => { attempts += 1; throw new Error("Manager request timed out"); },
      readback: async () => ({ state })
    });
    assert.equal(result.state, state);
    assert.equal(attempts, 1);
  }
});

test("requirement delivery timeout retries once only after missing readback", async () => {
  let attempts = 0;
  const result = await deliverRequirementBatchWithRecovery({
    deliveryId: "delivery-missing",
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Manager request timed out");
      return { state: "completed" as const };
    },
    readback: async () => ({ state: "missing" })
  });
  assert.equal(result.state, "completed");
  assert.equal(attempts, 2);
});
