import assert from "node:assert/strict";
import test from "node:test";
import { buildManagerHealthSnapshot } from "./managerHealth.js";

const base = {
  pluginReadiness: { state: "ready" as const, missingCapabilities: [] as readonly string[] },
  routesReady: true,
  routeReadyCount: 2,
  routeRequiredCount: 2,
  blockedRouteIds: [] as readonly string[],
  failedRouteIds: [] as readonly string[],
  backgroundIncidentCount: 0,
  pid: 4242,
  checkedAt: "2026-08-30T00:00:00.000Z"
};

test("Manager health separates event-loop liveness from required and business readiness", () => {
  assert.deepEqual(buildManagerHealthSnapshot(base), {
    state: "healthy",
    scope: "application_generation",
    checkedAt: base.checkedAt,
    pid: 4242,
    live: true,
    requiredReady: true,
    businessReady: true,
    message: "Manager event loop, required capabilities, and enabled Route ingress are ready."
  });
});

test("missing required capabilities are not hidden inside generic degraded health", () => {
  const health = buildManagerHealthSnapshot({
    ...base,
    pluginReadiness: {
      state: "degraded",
      missingCapabilities: ["manager.core@1"]
    }
  });

  assert.equal(health.live, true);
  assert.equal(health.requiredReady, false);
  assert.equal(health.businessReady, true);
  assert.equal(health.state, "degraded");
  assert.match(health.message, /manager\.core@1/);
});

test("optional plugin and Route degradation preserve required generation readiness", () => {
  const optionalPlugin = buildManagerHealthSnapshot({
    ...base,
    pluginReadiness: { state: "degraded", missingCapabilities: [] }
  });
  const routeDegraded = buildManagerHealthSnapshot({
    ...base,
    routesReady: false,
    routeReadyCount: 1,
    blockedRouteIds: ["needs-login"]
  });

  assert.equal(optionalPlugin.requiredReady, true);
  assert.equal(optionalPlugin.state, "degraded");
  assert.equal(routeDegraded.requiredReady, true);
  assert.equal(routeDegraded.businessReady, false);
  assert.equal(routeDegraded.state, "degraded");
});
