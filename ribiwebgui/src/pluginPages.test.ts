/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { defineComponent } from "vue";
import { buildWebNavigation } from "./pluginNavigation";
import {
  isWebPageRouteActive,
  registerTrustedWebPage,
  resolveWebPageCatalog,
  webPageDataRequirements,
  webPageRenderer
} from "./pluginPages";

function page(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "page", surface: "web.pages", id: "performance-page",
    instanceId: "manager:performance", pluginId: "io.rabiroute.manager.performance",
    routeId: "global.performance", rendererId: "builtin.web-page.performance.v1", hosts: ["web"], ...overrides
  };
}

function navigation(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "navigation", surface: "web.navigation", id: "performance",
    instanceId: "manager:performance", pluginId: "io.rabiroute.manager.performance",
    label: { fallback: "性能监控" }, routeId: "global.performance",
    icon: "mdi-chart-timeline-variant", slot: "utility", hosts: ["web"], order: 60, ...overrides
  };
}

function registerPerformancePage(): () => void {
  return registerTrustedWebPage({
    instanceId: "manager:performance", pluginId: "io.rabiroute.manager.performance",
    routeId: "global.performance", rendererId: "builtin.web-page.performance.v1",
    loader: async () => defineComponent({ template: "<div />" }),
    paths: [{ path: "/performance", title: "性能监控" }],
    navigation: { resolvePath: () => "/performance", allowedSlots: ["utility"], allowedIcons: ["mdi-chart-timeline-variant"] }
  });
}

test("page catalog accepts only active Bundle owner-bound route and renderer pairs", () => {
  const dispose = registerPerformancePage();
  try {
    const catalog = resolveWebPageCatalog([
      page(), page({ id: "cross-instance", instanceId: "manager:other" }),
      page({ id: "cross-plugin", pluginId: "example.other" }), page({ id: "wrong-surface", surface: "shared.settings" }),
      page({ id: "unknown-renderer", rendererId: "plugin.remote-component.v1" }), page({ id: "unknown-route", routeId: "plugin.remote-route" })
    ], "ready");
    assert.equal(catalog.mode, "catalog");
    assert.deepEqual(catalog.pages.map(item => [item.routeId, item.rendererId]), [["global.performance", "builtin.web-page.performance.v1"]]);
    assert.equal(isWebPageRouteActive(catalog, "global.performance"), true);
    assert.equal(webPageRenderer("global.performance").rendererId, "builtin.web-page.performance.v1");
    assert.deepEqual(webPageDataRequirements("global.performance"), []);
  } finally { dispose(); }
});

test("first catalog failure exposes recovery mode without plugin pages", () => {
  assert.deepEqual(resolveWebPageCatalog(null, "unavailable"), { mode: "recovery", pages: [] });
  assert.deepEqual(resolveWebPageCatalog(null, "loading"), { mode: "loading", pages: [] });
});

test("navigation requires an active page from the same plugin owner", () => {
  const dispose = registerPerformancePage();
  try {
    const active = buildWebNavigation([page(), navigation()], "main");
    assert.deepEqual(active.utility.map(item => [item.id, item.to]), [["performance", "/performance"]]);
    assert.equal(buildWebNavigation([navigation()], "main").utility.length, 0);
    assert.equal(buildWebNavigation([page({ instanceId: "manager:other" }), navigation()], "main").utility.length, 0);
  } finally { dispose(); }
});
