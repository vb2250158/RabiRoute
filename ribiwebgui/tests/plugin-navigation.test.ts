import assert from "node:assert/strict";
import test from "node:test";
import { buildWebNavigation } from "../src/pluginNavigation";

type NavigationOverrides = Partial<{
  id: string;
  instanceId: string;
  kind: string;
  surface: string;
  label: unknown;
  routeId: string;
  icon: string;
  slot: string;
  hosts: unknown;
  order: number;
}>;

function navigation(overrides: NavigationOverrides = {}): unknown {
  return {
    kind: "navigation",
    surface: "web.navigation",
    id: "plugin-link",
    instanceId: "manager:plugin-link",
    pluginId: "package:plugin-link",
    label: { fallback: "插件入口" },
    routeId: "global.performance",
    icon: "mdi-chart-timeline-variant",
    slot: "utility",
    hosts: ["web"],
    order: 60,
    ...overrides
  };
}

test("Web navigation falls back to the existing primary, utility, and guide entries", () => {
  const groups = buildWebNavigation(null, "main route");

  assert.deepEqual(groups.routePrimary.map(item => item.id), [
    "overview",
    "message-adapters",
    "persona",
    "knowledge"
  ]);
  assert.deepEqual(groups.personaSecondary.map(item => [item.id, item.to]), [
    ["persona-sync", "/routes/main%20route/persona/sync"]
  ]);
  assert.deepEqual(groups.utility.map(item => item.id), [
    "speech",
    "performance",
    "runtime",
    "settings"
  ]);
  assert.deepEqual(groups.footer.map(item => [item.id, item.to]), [["docs", "/docs"]]);
  assert.equal(groups.routePrimary[0]?.to, "/routes/main%20route/overview");
});

test("Web navigation resolves the controlled v2 routeId whitelist", () => {
  const selectedRouteId = "Main /../?route=#one";
  const encodedRouteId = encodeURIComponent(selectedRouteId);
  const groups = buildWebNavigation([
    navigation({ id: "catalog-overview", instanceId: "manager:core", label: { fallback: "控制台" }, routeId: "route.overview", icon: "mdi-view-dashboard-outline", slot: "route-primary", order: 10 }),
    navigation({ id: "catalog-adapters", instanceId: "manager:core", label: { fallback: "消息适配器" }, routeId: "route.adapters", icon: "mdi-puzzle-outline", slot: "route-primary", order: 20 }),
    navigation({ id: "catalog-persona", instanceId: "manager:persona", label: { fallback: "人格配置" }, routeId: "route.persona", icon: "mdi-account-heart-outline", slot: "route-primary", order: 30 }),
    navigation({ id: "catalog-persona-sync", instanceId: "manager:persona", label: { fallback: "人格同步" }, routeId: "route.persona-sync", icon: "mdi-folder-sync-outline", slot: "persona-secondary", order: 35 }),
    navigation({ id: "catalog-knowledge", instanceId: "manager:persona", label: { fallback: "计划与记忆" }, routeId: "route.knowledge", icon: "mdi-notebook-check-outline", slot: "route-primary", order: 40 }),
    navigation({ id: "catalog-settings", instanceId: "manager:core", label: { fallback: "目录设置" }, routeId: "global.settings", icon: "mdi-cog-outline", slot: "utility", order: 5 }),
    navigation({ id: "catalog-speech", instanceId: "manager:speech", label: { fallback: "语音服务" }, routeId: "route.speech", icon: "mdi-waveform", slot: "utility", order: 50 }),
    navigation({ id: "catalog-performance", instanceId: "manager:performance", label: { fallback: "性能监控" }, routeId: "global.performance", icon: "mdi-chart-timeline-variant", slot: "utility", order: 60 }),
    navigation({ id: "catalog-runtime", instanceId: "manager:core", label: { fallback: "日志诊断" }, routeId: "route.runtime", icon: "mdi-console-line", slot: "utility", order: 70 }),
    navigation({ id: "catalog-docs", instanceId: "manager:core", label: { fallback: "目录手册" }, routeId: "global.docs", icon: "mdi-book-open-page-variant-outline", slot: "footer", order: 1 })
  ], selectedRouteId);

  assert.deepEqual(
    [...groups.routePrimary, ...groups.personaSecondary, ...groups.utility, ...groups.footer]
      .map(item => [item.id, item.to])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    [
      ["catalog-settings", "/settings"],
      ["catalog-docs", "/docs"],
      ["catalog-overview", `/routes/${encodedRouteId}/overview`],
      ["catalog-adapters", `/routes/${encodedRouteId}/adapters`],
      ["catalog-persona", `/routes/${encodedRouteId}/persona`],
      ["catalog-persona-sync", `/routes/${encodedRouteId}/persona/sync`],
      ["catalog-knowledge", `/routes/${encodedRouteId}/knowledge`],
      ["catalog-speech", `/routes/${encodedRouteId}/speech`],
      ["catalog-performance", "/performance"],
      ["catalog-runtime", `/routes/${encodedRouteId}/runtime`]
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  );
});

test("Web navigation orders accepted entries inside each controlled slot", () => {
  const groups = buildWebNavigation([
    navigation({ id: "settings-from-catalog", instanceId: "manager:settings", label: { fallback: "目录设置" }, routeId: "global.settings", icon: "mdi-cog-outline", slot: "utility", order: 5 }),
    navigation({ id: "docs-from-catalog", instanceId: "manager:core", label: { fallback: "目录手册" }, routeId: "global.docs", icon: "mdi-book-open-page-variant-outline", slot: "footer", order: 1 })
  ], "main");

  assert.deepEqual(groups.utility.map(item => item.id), [
    "settings-from-catalog",
    "speech",
    "performance",
    "runtime"
  ]);
  assert.deepEqual(groups.footer.map(item => [item.id, item.title]), [
    ["docs-from-catalog", "目录手册"]
  ]);
});

test("Web navigation ignores unknown kinds, route IDs, icons, and slot combinations", () => {
  const groups = buildWebNavigation([
    { kind: "command", surface: "web.navigation", endpoint: "/api/admin", action: { module: "remote" } },
    navigation({ id: "wrong-surface", surface: "desktop.navigation" }),
    navigation({ id: "external-route", routeId: "https://example.com/plugin.js" }),
    navigation({ id: "api-route", routeId: "/api/private/action" }),
    navigation({ id: "unknown-route", routeId: "plugin.arbitrary-module" }),
    navigation({ id: "unknown-icon", icon: "mdi-script-text<script>" }),
    navigation({ id: "unknown-slot", slot: "plugin-panel" }),
    navigation({ id: "wrong-docs-slot", routeId: "global.docs", icon: "mdi-book-open-page-variant-outline", slot: "utility" }),
    navigation({ id: "wrong-overview-slot", routeId: "route.overview", icon: "mdi-view-dashboard-outline", slot: "utility" }),
    navigation({ id: "wrong-persona-sync-slot", routeId: "route.persona-sync", icon: "mdi-folder-sync-outline", slot: "route-primary" })
  ], "main");

  assert.equal(groups.routePrimary.length, 4);
  assert.equal(groups.personaSecondary.length, 1);
  assert.equal(groups.utility.length, 4);
  assert.deepEqual(groups.footer.map(item => item.id), ["docs"]);
  assert.equal(groups.utility.some(item => item.id.includes("route")), false);
  assert.equal(groups.utility.find(item => item.id === "settings")?.to, "/settings");
});

test("Route routeIds use unscoped recovery paths when no Route is selected", () => {
  const groups = buildWebNavigation([
    navigation({
      id: "overview-from-catalog",
      instanceId: "manager:core",
      label: { fallback: "控制台" },
      routeId: "route.overview",
      icon: "mdi-view-dashboard-outline",
      slot: "route-primary",
      order: 10
    })
  ], "");

  assert.equal(groups.routePrimary[0]?.to, "/overview");
});
