/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import "./builtinStartupPages";
import { registeredWebPages } from "./pluginPages";

test("knowledge route is registered before the optional Web Bundle catalog", () => {
  const page = registeredWebPages().find((entry) => entry.routeId === "route.knowledge");
  assert.deepEqual(page && {
    instanceId: page.instanceId,
    pluginId: page.pluginId,
    rendererId: page.rendererId,
    paths: page.paths.map((path) => path.path)
  }, {
    instanceId: "manager:persona",
    pluginId: "rabi.manager.base",
    rendererId: "builtin.web-page.knowledge.v1",
    paths: ["/routes/:id/knowledge", "/knowledge"]
  });
});
