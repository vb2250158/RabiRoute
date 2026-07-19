import assert from "node:assert/strict";
import test from "node:test";
import { rolePanelDeliveryExitCode } from "./rolePanelDelivery.js";

test("role panel only reports a delivered packet as success", () => {
  assert.equal(rolePanelDeliveryExitCode("delivered"), 0);
  assert.equal(rolePanelDeliveryExitCode("failed"), 1);
  assert.equal(rolePanelDeliveryExitCode("missed"), 2);
  assert.equal(rolePanelDeliveryExitCode("routed"), 2);
  assert.equal(rolePanelDeliveryExitCode("skipped"), 2);
});
