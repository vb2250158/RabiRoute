import assert from "node:assert/strict";
import test from "node:test";
import { isPluginCapabilityReference } from "./capabilityReference.js";

test("plugin capability references require name@major", () => {
  assert.equal(isPluginCapabilityReference("manager.core@1"), true);
  assert.equal(isPluginCapabilityReference("host.manager.message-adapter-control@12"), true);
  assert.equal(isPluginCapabilityReference("manager.core"), false);
  assert.equal(isPluginCapabilityReference("manager.core@0"), false);
  assert.equal(isPluginCapabilityReference(" manager.core@1"), false);
});
