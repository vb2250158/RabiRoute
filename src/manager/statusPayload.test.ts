import assert from "node:assert/strict";
import test from "node:test";
import { gatewayPayloadIncludesDiagnostics, standaloneGatewayPayload } from "./statusPayload.js";

test("gateway summary requests omit diagnostic payload work", () => {
  assert.equal(gatewayPayloadIncludesDiagnostics(new URLSearchParams("summary=1")), false);
  assert.equal(gatewayPayloadIncludesDiagnostics(new URLSearchParams()), true);
});

test("gateway payload delegates status detail selection to its status provider", () => {
  const runtime = { definition: { id: "route-1" } } as never;
  const calls: string[] = [];

  const payload = standaloneGatewayPayload({
    runtimes: [runtime],
    runtimeStatus: () => {
      calls.push("route-1");
      return { id: "route-1", running: true };
    },
    routeDir: "data/route",
    rolesDir: "data/roles"
  });

  assert.deepEqual(calls, ["route-1"]);
  assert.deepEqual((payload.data as { manager: unknown[] }).manager, [{ id: "route-1", running: true }]);
});

test("gateway summary payload omits full config definitions", () => {
  const runtime = { definition: { id: "route-1", accessToken: "secret" } } as never;

  const payload = standaloneGatewayPayload(
    {
      runtimes: [runtime],
      runtimeStatus: () => ({ id: "route-1" }),
      routeDir: "data/route",
      rolesDir: "data/roles"
    },
    { includeConfigDefinitions: false }
  );

  assert.deepEqual((payload.data as { config: { gateways: unknown[] } }).config.gateways, []);
});
