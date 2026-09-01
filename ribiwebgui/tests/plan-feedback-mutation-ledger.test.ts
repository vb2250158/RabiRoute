import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { PlanFeedbackMutationLedger } from "../src/planFeedbackMutationLedger.js";

test("plan feedback ledger falls back to memory when the sessionStorage getter throws", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("storage disabled", "SecurityError");
    }
  });
  try {
    const ledger = new PlanFeedbackMutationLedger(undefined, webcrypto as unknown as Crypto);
    const signature = "a".repeat(64);
    const first = ledger.retain("YeYu", "plan-1", signature);
    const retryAfterRemount = ledger.retain("YeYu", "plan-1", signature);
    assert.equal(retryAfterRemount.feedbackId, first.feedbackId);

    assert.throws(
      () => ledger.retain("YeYu", "plan-1", "b".repeat(64)),
      /still unresolved/
    );
    assert.equal(ledger.retain("YeYu", "plan-1", signature).feedbackId, first.feedbackId);
    ledger.complete("YeYu", "plan-1");
    assert.notEqual(ledger.retain("YeYu", "plan-1", "b".repeat(64)).feedbackId, first.feedbackId);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("plan feedback ledger updates memory before a storage write failure", () => {
  const storage = {
    getItem() {
      throw new DOMException("storage disabled", "SecurityError");
    },
    setItem() {
      throw new DOMException("storage disabled", "SecurityError");
    }
  };
  const ledger = new PlanFeedbackMutationLedger(storage, webcrypto as unknown as Crypto);
  const signature = "c".repeat(64);
  const first = ledger.retain("YeYu", "plan-2", signature);
  assert.equal(ledger.retain("YeYu", "plan-2", signature).feedbackId, first.feedbackId);
});
