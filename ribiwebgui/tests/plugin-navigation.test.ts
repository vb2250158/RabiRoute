import assert from "node:assert/strict";
import test from "node:test";
import { buildWebNavigation } from "../src/pluginNavigation";

const rendererByRoute = {
  "route.overview": "builtin.web-page.overview.v1",
  "route.adapters": "builtin.web-page.adapters.v1",
  "route.persona": "builtin.web-page.persona.v1",
  "route.knowledge": "builtin.web-page.knowledge.v1",
  "route.persona-sync": "builtin.web-page.persona-sync.v1",
  "route.speech": "builtin.web-page.speech.v1",
  "global.performance": "builtin.web-page.performance.v1",
  "route.runtime": "builtin.web-page.runtime.v1",
  "global.settings": "builtin.web-page.settings.v1",
  "global.docs": "builtin.web-page.docs.v1"
} as const;

type RouteId = keyof typeof rendererByRoute;

function page(routeId: RouteId, instanceId: string, rendererId = rendererByRoute[routeId]): unknown {
  return {
    kind: "page",
    id: `${routeId}-page`,
    instanceId,
    pluginId: `package:${instanceId}`,
    routeId,
    rendererId,
    hosts: ["web"]
  };
}

function navigation(options: {
  id: string;
  instanceId: string;
  routeId: RouteId | string;
  label: string;
  icon: string;
  slot: string;
  order: number;
  kind?: string;
}): unknown {
  return {
    kind: options.kind ?? "navigation",
    surface: "web.navigation",
    id: options.id,
    instanceId: options.instanceId,
    pluginId: `package:${options.instanceId}`,
    label: { fallback: options.label },
    routeId: options.routeId,
    icon: options.icon,
    slot: options.slot,
    hosts: ["web"],
    order: options.order
  };
}

function pair(options: Parameters<typeof navigation>[0]): unknown[] {
  return [page(options.routeId as RouteId, options.instanceId), navigation(options)];
}

test("Web navigation is empty before a successful plugin catalog", () => {
  assert.deepEqual(buildWebNavigation(null, "main"), {
    routePrimary: [],
    personaSecondary: [],
    utility: [],
    footer: []
  });
});

test("Web navigation resolves activated page routes and controlled slots", () => {
  const selected = "Main /../?route=#one";
  const groups = buildWebNavigation([
    ...pair({ id: "overview", instanceId: "manager:core", routeId: "route.overview", label: "控制台", icon: "mdi-view-dashboard-outline", slot: "route-primary", order: 10 }),
    ...pair({ id: "persona-sync", instanceId: "manager:persona", routeId: "route.persona-sync", label: "人格同步", icon: "mdi-folder-sync-outline", slot: "persona-secondary", order: 40 }),
    ...pair({ id: "settings", instanceId: "manager:core", routeId: "global.settings", label: "设置", icon: "mdi-cog-outline", slot: "utility", order: 80 }),
    ...pair({ id: "docs", instanceId: "manager:core", routeId: "global.docs", label: "手册", icon: "mdi-book-open-page-variant-outline", slot: "footer", order: 90 })
  ], selected);

  assert.deepEqual(groups.routePrimary.map(item => item.to), [`/routes/${encodeURIComponent(selected)}/overview`]);
  assert.deepEqual(groups.personaSecondary.map(item => item.to), [`/routes/${encodeURIComponent(selected)}/persona/sync`]);
  assert.deepEqual(groups.utility.map(item => item.to), ["/settings"]);
  assert.deepEqual(groups.footer.map(item => item.to), ["/docs"]);
});

test("Web navigation requires a fixed renderer and the same active plugin instance", () => {
  const groups = buildWebNavigation([
    page("global.performance", "manager:other"),
    navigation({ id: "owner-mismatch", instanceId: "manager:performance", routeId: "global.performance", label: "性能", icon: "mdi-chart-timeline-variant", slot: "utility", order: 10 }),
    page("global.settings", "manager:core", "plugin.remote-component.v1" as never),
    navigation({ id: "unknown-renderer", instanceId: "manager:core", routeId: "global.settings", label: "设置", icon: "mdi-cog-outline", slot: "utility", order: 20 }),
    navigation({ id: "unknown-route", instanceId: "manager:core", routeId: "plugin.remote-route", label: "远程", icon: "mdi-cog-outline", slot: "utility", order: 30 })
  ], "main");

  assert.equal(groups.utility.length, 0);
});

test("accepted navigation keeps catalog ordering and unscoped Route recovery paths", () => {
  const groups = buildWebNavigation([
    ...pair({ id: "adapters", instanceId: "manager:core", routeId: "route.adapters", label: "适配器", icon: "mdi-puzzle-outline", slot: "route-primary", order: 20 }),
    ...pair({ id: "overview", instanceId: "manager:core", routeId: "route.overview", label: "控制台", icon: "mdi-view-dashboard-outline", slot: "route-primary", order: 10 })
  ], "");

  assert.deepEqual(groups.routePrimary.map(item => [item.id, item.to]), [
    ["overview", "/overview"],
    ["adapters", "/routes"]
  ]);
});
