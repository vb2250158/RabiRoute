import assert from "node:assert/strict";
import test from "node:test";
import { agentStateReportDecision } from "./stateReportOrder.js";

test("agent state reports reject stale process generations", () => {
  assert.equal(agentStateReportDecision("new", "old", 2, 1), "invalid-generation");
  assert.equal(agentStateReportDecision(undefined, "old", 2, 1), "invalid-generation");
});

test("agent state reports reject out-of-order delivery within one generation", () => {
  assert.equal(agentStateReportDecision("same", "same", 2, 3), "out-of-order");
  assert.equal(agentStateReportDecision("same", "same", 3, 3), "out-of-order");
  assert.equal(agentStateReportDecision("same", "same", 4, 3), "accept");
});
