/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { buildWebNavigation } from "./pluginNavigation";
import {
  isWebPageRouteActive,
  resolveWebPageCatalog,
  webPageDataRequirements,
  webPageRenderer
} from "./pluginPages";

function page(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "page",
    surface: "web.pages",
    id: "performance-page",
    instanceId: "manager:performance",
    pluginId: "builtin:manager/performance",
    routeId: "global.performance",
    rendererId: "builtin.web-page.performance.v1",
    hosts: ["web"],
    ...overrides
  };
}

function navigation(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "navigation",
    surface: "web.navigation",
    id: "performance",
    instanceId: "manager:performance",
    pluginId: "builtin:manager/performance",
    label: { fallback: "性能监控" },
    routeId: "global.performance",
    icon: "mdi-chart-timeline-variant",
    slot: "utility",
    hosts: ["web"],
    order: 60,
    ...overrides
  };
}

test("page catalog accepts only owner-bound route and renderer pairs", () => {
  const catalog = resolveWebPageCatalog([
    page(),
    page({ id: "cross-instance", instanceId: "manager:other" }),
    page({ id: "cross-plugin", pluginId: "builtin:manager/other" }),
    page({ id: "wrong-surface", surface: "shared.settings" }),
    page({ id: "unknown-renderer", rendererId: "plugin.remote-component.v1" }),
    page({ id: "unknown-route", routeId: "plugin.remote-route" })
  ], "ready");

  assert.equal(catalog.mode, "catalog");
  assert.deepEqual(catalog.pages.map(item => [item.routeId, item.rendererId]), [[
    "global.performance",
    "builtin.web-page.performance.v1"
  ]]);
  assert.equal(isWebPageRouteActive(catalog, "global.performance"), true);
  assert.equal(webPageRenderer("global.performance").rendererId, "builtin.web-page.performance.v1");
  assert.deepEqual(webPageDataRequirements("route.adapters"), ["gateway.diagnostics"]);
  assert.deepEqual(webPageDataRequirements("global.performance"), []);
});

test("first catalog failure exposes recovery mode without plugin pages", () => {
  assert.deepEqual(resolveWebPageCatalog(null, "unavailable"), { mode: "recovery", pages: [] });
  assert.deepEqual(resolveWebPageCatalog(null, "loading"), { mode: "loading", pages: [] });
});

test("navigation requires an active page from the same plugin owner", () => {
  const active = buildWebNavigation([page(), navigation()], "main");
  assert.deepEqual(active.utility.map(item => [item.id, item.to]), [["performance", "/performance"]]);

  const missingPage = buildWebNavigation([navigation()], "main");
  assert.equal(missingPage.utility.length, 0);

  const otherOwner = buildWebNavigation([
    page({ instanceId: "manager:other" }),
    navigation()
  ], "main");
  assert.equal(otherOwner.utility.length, 0);
});
