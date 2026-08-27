/// <reference types="node" />
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("a cold optional page route keeps its requested path until the Bundle registers", () => {
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
  assert.match(router, /redirect: to => \(\{ name: PLUGIN_RECOVERY_ROUTE_NAME, query: \{ from: to\.fullPath \} \}\)/);
  assert.match(router, /current\.name === PLUGIN_RECOVERY_ROUTE_NAME && requestedPath\.startsWith\("\/"\)/);
  assert.match(router, /requestedRoute\.meta\.pluginRouteId === change\.registration\.routeId/);
  assert.match(router, /router\.replace\(requestedRoute\.fullPath\)/);
});
