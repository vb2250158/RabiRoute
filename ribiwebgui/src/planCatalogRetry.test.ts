import assert from "node:assert/strict";
import test from "node:test";
import { parseRetryAfter, retryPlanCatalogInitialization } from "./planCatalogRetry";

test("Retry-After accepts seconds and HTTP dates only", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("999999999999999999999999"), Number.POSITIVE_INFINITY);
  assert.equal(parseRetryAfter("Tue, 01 Jan 2030 00:00:02 GMT", Date.parse("2030-01-01T00:00:00Z")), 2000);
  for (const value of [null, "-1", "2.5", "tomorrow", "2030-01-01"]) assert.equal(parseRetryAfter(value), undefined);
});

test("initialization retries serially without changing the operation", async () => {
  let calls = 0;
  const initializing = new Error("initializing");
  const result = await retryPlanCatalogInitialization(async () => {
    if (++calls < 2) throw initializing;
    return ["expected"];
  }, { retryDelay: error => error === initializing ? 0 : undefined });
  assert.deepEqual(result, ["expected"]);
  assert.equal(calls, 2);
});

test("unrelated errors and delays exceeding the budget are not retried", async () => {
  for (const delay of [undefined, 5000]) {
    let calls = 0;
    const error = new Error("original");
    await assert.rejects(retryPlanCatalogInitialization(async () => { calls++; throw error; }, {
      retryDelay: () => delay, budgetMs: 1000
    }), caught => caught === error);
    assert.equal(calls, 1);
  }
});

test("cancellation stops waiting and rejects late successful output", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(retryPlanCatalogInitialization(async () => {
    calls++;
    throw new Error("initializing");
  }, { signal: controller.signal, retryDelay: () => 1000,
    onInitializing: () => controller.abort() }), /abort/i);
  assert.equal(calls, 1);
  const late = new AbortController();
  await assert.rejects(retryPlanCatalogInitialization(async () => {
    late.abort(); return [];
  }, { signal: late.signal, retryDelay: () => undefined }), /abort/i);
});
