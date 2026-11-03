import assert from "node:assert/strict";
import test from "node:test";
import { createMessageEndpointHostPorts } from "./messageEndpointHostPorts.js";

test("shared owners load once on demand and an unrelated failed owner stays local", async () => {
  let brokenLoads = 0, healthyLoads = 0;
  const healthyOwner = Object.freeze({ record: () => "healthy" });
  const ports = await createMessageEndpointHostPorts({ loaders: {
    broken: async () => { brokenLoads += 1; throw new Error("controlled owner import failure"); },
    healthy: async () => { healthyLoads += 1; return healthyOwner; }
  } });
  assert.equal(brokenLoads + healthyLoads, 0, "Constructing ports never imports optional owners.");
  await assert.rejects(ports.prepareModules(["broken"]), /controlled owner import failure/);
  await Promise.all([ports.prepareModules(["healthy"]), ports.prepareModules(["healthy"])]);
  assert.equal(ports.module("healthy"), healthyOwner);
  assert.equal(healthyLoads, 1);
  assert.equal(brokenLoads, 1);
});
