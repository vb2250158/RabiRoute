import assert from "node:assert/strict";
import test from "node:test";
import { defineComponent } from "vue";
import { activateCore } from "../src/bundles/builtinWebContributions";
import {
  onTrustedWebPageRegistrationChange,
  parseWebPageContribution,
  registerTrustedWebPage,
  registeredWebPages,
  resolveRegisteredWebPagePath,
  webPageAllowsNavigation,
  webPageDataRequirements,
  webPageRenderer
} from "../src/pluginPages";
import { activateWebPluginForTest } from "./web-plugin-test-host";

const trustedOwner = {
  instanceId: "manager:trusted",
  pluginId: "package:trusted"
} as const;


const disposeCore = activateWebPluginForTest(
  { instanceId: "manager:core", pluginId: "io.rabiroute.manager.core" },
  activateCore
);

test.after(() => disposeCore());

test("built-in pages are installed through the trusted registration API", () => {
  const overview = webPageRenderer("route.overview");
  assert.equal(overview.rendererId, "builtin.web-page.overview.v1");
  assert.deepEqual(overview.paths.map(entry => entry.path), ["/overview", "/routes/:id/overview"]);
  assert.equal(webPageAllowsNavigation("route.overview", "route-primary", "mdi-view-dashboard-outline"), false);
  assert.equal(webPageAllowsNavigation("route.overview", "utility", "mdi-view-dashboard-outline"), true);
  assert.deepEqual(webPageDataRequirements("route.overview"), ["gateway.diagnostics"]);
});

test("trusted registration publishes custom page contracts and removes them through its disposer", () => {
  const routeId = "trusted.page.contract";
  const rendererId = "trusted.web-page.contract.v1";
  const changes: string[] = [];
  const stopObserving = onTrustedWebPageRegistrationChange(change => {
    if (change.registration.routeId === routeId) changes.push(change.type);
  });
  const dispose = registerTrustedWebPage({
    ...trustedOwner,
    routeId,
    rendererId,
    loader: async () => defineComponent({ template: "<div>trusted</div>" }),
    paths: [
      { path: "/trusted-contract", title: "可信页面" },
      { path: "/trusted-contract/:id", title: "可信页面" }
    ],
    requirements: ["gateway.diagnostics"],
    navigation: {
      resolvePath: selectedRouteId => selectedRouteId ? `/trusted-contract/${encodeURIComponent(selectedRouteId)}` : "/trusted-contract",
      allowedSlots: ["utility"],
      allowedIcons: ["mdi-shield-check-outline"]
    }
  });

  try {
    assert.equal(registeredWebPages().some(entry => entry.routeId === routeId), true);
    assert.equal(resolveRegisteredWebPagePath(routeId, "main route"), "/trusted-contract/main%20route");
    assert.deepEqual(webPageDataRequirements(routeId), ["gateway.diagnostics"]);
    assert.equal(webPageAllowsNavigation(routeId, "utility", "mdi-shield-check-outline"), true);
    assert.deepEqual(parseWebPageContribution({
      kind: "page",
      surface: "web.pages",
      instanceId: "manager:trusted",
      pluginId: "package:trusted",
      hosts: ["web"],
      routeId,
      rendererId
    }), {
      instanceId: "manager:trusted",
      pluginId: "package:trusted",
      routeId,
      rendererId
    });
    assert.equal(parseWebPageContribution({
      kind: "page",
      surface: "web.pages",
      instanceId: "manager:trusted",
      pluginId: "package:trusted",
      hosts: ["web"],
      routeId,
      rendererId: "trusted.web-page.unregistered.v1"
    }), undefined);
  } finally {
    dispose();
    stopObserving();
  }

  assert.deepEqual(changes, ["registered", "unregistered"]);
  assert.equal(parseWebPageContribution({
    kind: "page",
    surface: "web.pages",
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    hosts: ["web"],
    routeId,
    rendererId
  }), undefined);
});

test("trusted registration rolls back when a host listener rejects route installation", () => {
  const routeId = "trusted.page.rollback";
  const rendererId = "trusted.web-page.rollback.v1";
  const changes: string[] = [];
  const stopObserving = onTrustedWebPageRegistrationChange(change => {
    if (change.registration.routeId === routeId) changes.push(change.type);
  });
  const stopRejecting = onTrustedWebPageRegistrationChange(change => {
    if (change.type === "registered" && change.registration.routeId === routeId) {
      throw new Error("route mount rejected");
    }
  });

  try {
    assert.throws(() => registerTrustedWebPage({
      ...trustedOwner,
      routeId,
      rendererId,
      loader: async () => defineComponent({ template: "<div />" }),
      paths: [{ path: "/trusted-rollback", title: "回滚页面" }]
    }), /route mount rejected/);
  } finally {
    stopRejecting();
    stopObserving();
  }
  assert.deepEqual(changes, ["registered", "unregistered"]);

  const dispose = registerTrustedWebPage({
    ...trustedOwner,
    routeId,
    rendererId,
    loader: async () => defineComponent({ template: "<div />" }),
    paths: [{ path: "/trusted-rollback", title: "回滚页面" }]
  });
  dispose();
});

test("trusted registration rejects route, renderer, path, and resolver collisions", () => {
  assert.throws(() => registerTrustedWebPage({
    ...trustedOwner,
    routeId: "route.overview",
    rendererId: "trusted.web-page.duplicate-route.v1",
    loader: async () => defineComponent({ template: "<div />" }),
    paths: [{ path: "/trusted-duplicate-route", title: "重复路线" }]
  }), /route is already registered/);

  assert.throws(() => registerTrustedWebPage({
    ...trustedOwner,
    routeId: "trusted.duplicate-renderer",
    rendererId: "builtin.web-page.overview.v1",
    loader: async () => defineComponent({ template: "<div />" }),
    paths: [{ path: "/trusted-duplicate-renderer", title: "重复渲染器" }]
  }), /renderer is already registered/);

  assert.throws(() => registerTrustedWebPage({
    ...trustedOwner,
    routeId: "trusted.duplicate-path",
    rendererId: "trusted.web-page.duplicate-path.v1",
    loader: async () => defineComponent({ template: "<div />" }),
    paths: [{ path: "/overview", title: "重复路径" }]
  }), /path is already registered/);

  assert.throws(() => registerTrustedWebPage({
    ...trustedOwner,
    routeId: "trusted.reserved-path",
    rendererId: "trusted.web-page.reserved-path.v1",
    loader: async () => defineComponent({ template: "<div />" }),
    paths: [{ path: "/plugin-recovery", title: "保留路径" }]
  }), /path is invalid/);
});

test("trusted registration rejects unknown page data requirements", () => {
  assert.throws(() => registerTrustedWebPage({
    ...trustedOwner,
    routeId: "trusted.unknown-requirement",
    rendererId: "trusted.web-page.unknown-requirement.v1",
    loader: async () => defineComponent({ template: "<div />" }),
    paths: [{ path: "/trusted-unknown-requirement", title: "未知需求" }],
    requirements: ["gateway.unknown" as never]
  }), /requirements are invalid/);
});
