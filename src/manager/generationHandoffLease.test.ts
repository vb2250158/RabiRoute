import assert from "node:assert/strict";
import test from "node:test";
import { GenerationHandoffLease } from "./generationHandoffLease.js";

test("overlapping generations hand off a host-owned resource without an inactive gap", () => {
  const lease = new GenerationHandoffLease();
  const releaseOld = lease.acquire();
  const releaseNew = lease.acquire();

  assert.equal(lease.active, true);
  assert.equal(lease.size, 2);
  assert.equal(releaseOld(), false);
  assert.equal(lease.active, true);
  assert.equal(lease.size, 1);
  assert.equal(releaseOld(), false);
  assert.equal(releaseNew(), true);
  assert.equal(lease.active, false);
  assert.equal(lease.size, 0);
  assert.equal(releaseNew(), false);
});
