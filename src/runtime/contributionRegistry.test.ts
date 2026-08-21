import assert from "node:assert/strict";
import test from "node:test";
import { ContributionRegistry, type RabiUiContribution } from "./contributionRegistry.js";
import {
  CONTRIBUTION_REGISTRY_SERVICE,
  contributionPlugin,
  contributionRegistryServicePlugin
} from "./contributionRuntime.js";
import { RabiCordisHost } from "./cordisHost.js";

const diagnosticsPage = {
  kind: "page" as const,
  id: "diagnostics-page",
  label: { key: "page.diagnostics", fallback: "Diagnostics" },
  routeId: "route.diagnostics",
  rendererId: "builtin.web-page.diagnostics.v1",
  hosts: ["web"] as const,
  surface: "web.pages",
  slot: "main",
  order: 15
};

const diagnosticsNavigation = {
  kind: "navigation" as const,
  id: "diagnostics",
  label: { key: "nav.diagnostics", fallback: "Diagnostics" },
  routeId: "route.diagnostics",
  hosts: ["web"] as const,
  surface: "web.navigation",
  slot: "utility",
  order: 20
};

const restartCommand = {
  kind: "command" as const,
  id: "restart-gateway",
  label: { key: "command.restartGateway", fallback: "Restart gateway" },
  handlerId: "gateway.restart",
  dangerLevel: "confirm" as const,
  hosts: ["web", "desktop"] as const,
  surface: "manager.commands",
  slot: "gateway",
  requiredCapabilities: ["gateway.manage"] as const,
  order: 10
};

const restartTrayMenu = {
  kind: "tray-menu" as const,
  id: "restart-gateway-menu",
  label: { key: "tray.restartGateway", fallback: "Restart gateway" },
  commandId: "restart-gateway",
  hosts: ["desktop"] as const,
  surface: "desktop.tray",
  slot: "actions",
  order: 30
};

const systemTheme = {
  kind: "theme" as const,
  id: "system-theme",
  label: { key: "theme.system", fallback: "System" },
  themeId: "system",
  webResourceId: "builtin.web-theme.system.v1",
  desktopResourceId: "builtin.desktop-theme.system.v1",
  hosts: ["web", "desktop"] as const,
  surface: "appearance.themes",
  slot: "builtin",
  order: 5
};

const sharedContributions = [
  diagnosticsPage,
  diagnosticsNavigation,
  restartCommand,
  restartTrayMenu,
  systemTheme
] satisfies readonly RabiUiContribution[];

function pageBatch(
  page: RabiUiContribution = diagnosticsPage,
  navigation: RabiUiContribution = diagnosticsNavigation
): readonly RabiUiContribution[] {
  return [page, navigation];
}

test("Contribution Registry filters one shared catalog by host and order", async () => {
  const host = new RabiCordisHost();
  await host.mount(contributionRegistryServicePlugin);
  const fiber = await host.mount(contributionPlugin("builtin:diagnostics", sharedContributions));
  const registry = host.context.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;

  assert.deepEqual(
    registry.catalog("web").contributions.map((item) => `${item.kind}:${item.id}`),
    ["theme:system-theme", "command:restart-gateway", "page:diagnostics-page", "navigation:diagnostics"]
  );
  assert.deepEqual(
    registry.catalog("desktop").contributions.map((item) => `${item.kind}:${item.id}`),
    ["theme:system-theme", "command:restart-gateway", "tray-menu:restart-gateway-menu"]
  );
  assert.equal(registry.catalog().contributions.every((item) => item.pluginId === "builtin:diagnostics"), true);
  assert.equal(registry.catalog().contributions.every((item) => item.instanceId === "builtin:diagnostics"), true);

  const revisionAfterRegister = registry.catalog().revision;
  await fiber.dispose();
  assert.deepEqual(registry.catalog().contributions, []);
  assert.equal(registry.catalog().revision, revisionAfterRegister + 1);
  await host.dispose();
});

test("Contribution Registry keeps plugin implementation and instance identities separate", () => {
  const registry = new ContributionRegistry();
  registry.registerMany("package:diagnostics", sharedContributions, "manager:diagnostics-primary");

  const records = registry.catalog().contributions;
  assert.equal(records.every(item => item.pluginId === "package:diagnostics"), true);
  assert.equal(records.every(item => item.instanceId === "manager:diagnostics-primary"), true);
});

test("Contribution Registry rejects duplicate contribution and contract ids atomically", () => {
  const registry = new ContributionRegistry();
  registry.registerMany("builtin:first", pageBatch());

  assert.throws(() => registry.registerMany("builtin:second", [
    {
      ...diagnosticsPage,
      id: "other-page",
      rendererId: "builtin.web-page.other.v1"
    },
    {
      ...diagnosticsNavigation,
      id: "other-navigation"
    }
  ]), /Contribution contract already registered: page-route:route.diagnostics/);

  assert.throws(() => registry.registerMany("builtin:duplicate-key", [
    { ...diagnosticsPage, routeId: "route.other" },
    { ...diagnosticsNavigation, routeId: "route.other" }
  ]), /Contribution already registered: page:diagnostics-page/);

  registry.register("builtin:theme", systemTheme);
  assert.throws(() => registry.register("builtin:theme-copy", {
    ...systemTheme,
    id: "system-theme-copy"
  }), /Contribution contract already registered: theme:system/);

  assert.deepEqual(
    registry.catalog().contributions.map((item) => `${item.kind}:${item.id}`),
    ["theme:system-theme", "page:diagnostics-page", "navigation:diagnostics"]
  );
});

test("Contribution Registry normalizes identities before duplicate checks and storage", () => {
  const registry = new ContributionRegistry();
  registry.registerMany(" package:diagnostics ", [
    {
      ...diagnosticsPage,
      id: " diagnostics-page ",
      routeId: " route.diagnostics ",
      rendererId: " builtin.web-page.diagnostics.v1 ",
      surface: " web.pages ",
      slot: " main ",
      label: { key: " page.diagnostics ", fallback: " Diagnostics " },
      requiredCapabilities: [" diagnostics.read "]
    },
    {
      ...diagnosticsNavigation,
      id: " diagnostics ",
      routeId: " route.diagnostics ",
      surface: " web.navigation ",
      slot: " utility ",
      label: { key: " nav.diagnostics ", fallback: " Diagnostics " },
      requiredCapabilities: [" diagnostics.read "]
    }
  ], " manager:diagnostics ");

  const contribution = registry.catalog().contributions.find(item => item.kind === "navigation");
  assert.equal(contribution?.id, "diagnostics");
  assert.equal(contribution?.surface, "web.navigation");
  assert.equal(contribution?.slot, "utility");
  assert.deepEqual(contribution?.label, { key: "nav.diagnostics", fallback: "Diagnostics" });
  assert.deepEqual(contribution?.requiredCapabilities, ["diagnostics.read"]);
  assert.equal(contribution?.pluginId, "package:diagnostics");
  assert.equal(contribution?.instanceId, "manager:diagnostics");

  assert.throws(() => registry.registerMany("package:other", pageBatch()), /already registered/);
  assert.throws(() => registry.register("package:capabilities", {
    ...restartCommand,
    id: "duplicate-capability",
    requiredCapabilities: ["gateway.manage", " gateway.manage "]
  }), /required capabilities contain duplicates/);
});

test("Contribution Registry deep-clones nested contribution data", () => {
  const registry = new ContributionRegistry();
  registry.register("builtin:commands", restartCommand, "manager:commands");

  const first = registry.catalog().contributions.find(item => item.kind === "command");
  assert.ok(first?.kind === "command");
  first.label.fallback = "Changed";
  (first.requiredCapabilities as string[]).push("private.capability");

  const second = registry.catalog().contributions.find(item => item.kind === "command");
  assert.ok(second?.kind === "command");
  assert.equal(second.label.fallback, "Restart gateway");
  assert.deepEqual(second.requiredCapabilities, ["gateway.manage"]);
});

test("Contribution Registry publishes only controlled page and theme fields", () => {
  const registry = new ContributionRegistry();
  registry.registerMany("builtin:allowlist", [
    {
      ...diagnosticsPage,
      target: "https://example.com/plugin.js",
      endpoint: "/api/manager/shutdown",
      query: "/api/private",
      body: { command: "shutdown" },
      resourceRoot: "C:/private/plugin"
    } as unknown as RabiUiContribution,
    diagnosticsNavigation,
    {
      ...systemTheme,
      target: "https://example.com/theme.js",
      endpoint: "/api/theme",
      query: "/api/theme/private",
      body: { theme: "system" },
      resourceRoot: "C:/private/theme"
    } as unknown as RabiUiContribution
  ]);

  for (const contribution of registry.catalog().contributions) {
    for (const forbidden of ["target", "endpoint", "query", "body", "resourceRoot"]) {
      assert.equal(Object.hasOwn(contribution, forbidden), false);
    }
  }
  const page = registry.catalog("web").contributions.find(item => item.kind === "page");
  assert.ok(page?.kind === "page");
  assert.equal(page.routeId, "route.diagnostics");
  assert.equal(page.rendererId, "builtin.web-page.diagnostics.v1");
  const theme = registry.catalog().contributions.find(item => item.kind === "theme");
  assert.ok(theme?.kind === "theme");
  assert.equal(theme.themeId, "system");
  assert.equal(theme.webResourceId, "builtin.web-theme.system.v1");
  assert.equal(theme.desktopResourceId, "builtin.desktop-theme.system.v1");
});

test("Contribution Registry requires navigation pages in the same registration batch", () => {
  const registry = new ContributionRegistry();
  registry.register("builtin:page", diagnosticsPage, "manager:diagnostics-primary");

  assert.throws(() => registry.register(
    "builtin:page",
    diagnosticsNavigation,
    "manager:diagnostics-primary"
  ), /page reference is missing from the same registration batch/);
  assert.throws(() => registry.register(
    "builtin:page",
    diagnosticsNavigation,
    "manager:diagnostics-secondary"
  ), /page reference is missing from the same registration batch/);
  assert.deepEqual(
    registry.catalog().contributions.map(item => `${item.kind}:${item.id}`),
    ["page:diagnostics-page"]
  );
});

test("Contribution Registry rejects navigation hosts not supported by the referenced page", () => {
  const registry = new ContributionRegistry();
  assert.throws(() => registry.registerMany("builtin:invalid-page-host", [
    diagnosticsPage,
    {
      ...diagnosticsNavigation,
      hosts: ["web", "desktop"]
    }
  ]), /page reference is incompatible with hosts/);
  assert.deepEqual(registry.catalog().contributions, []);
});

test("Contribution Registry requires theme resources to match declared hosts", () => {
  const registry = new ContributionRegistry();
  registry.register("builtin:web-theme", {
    ...systemTheme,
    id: "web-theme",
    themeId: "web-only",
    hosts: ["web"],
    webResourceId: "builtin.web-theme.web-only.v1",
    desktopResourceId: undefined
  });
  registry.register("builtin:desktop-theme", {
    ...systemTheme,
    id: "desktop-theme",
    themeId: "desktop-only",
    hosts: ["desktop"],
    webResourceId: undefined,
    desktopResourceId: "builtin.desktop-theme.desktop-only.v1"
  });

  assert.throws(() => registry.register("builtin:missing-web-resource", {
    ...systemTheme,
    id: "missing-web-resource",
    themeId: "missing-web-resource",
    hosts: ["web"],
    webResourceId: undefined,
    desktopResourceId: undefined
  }), /web theme resource is incompatible with hosts/);
  assert.throws(() => registry.register("builtin:undeclared-desktop-host", {
    ...systemTheme,
    id: "undeclared-desktop-host",
    themeId: "undeclared-desktop-host",
    hosts: ["web"],
    webResourceId: "builtin.web-theme.extra.v1"
  }), /desktop theme resource is incompatible with hosts/);
});

test("Contribution Registry requires tray and hotkey commands in the same registration batch", () => {
  const registry = new ContributionRegistry();
  assert.throws(() => registry.register("builtin:orphan", restartTrayMenu), /same registration batch/);
  assert.throws(() => registry.registerMany("builtin:orphan-hotkey", [{
    kind: "hotkey",
    id: "restart-hotkey",
    label: { fallback: "Restart gateway" },
    commandId: "restart-gateway",
    defaultBinding: "Ctrl+Shift+R",
    hosts: ["desktop"],
    surface: "desktop.hotkeys",
    slot: "actions"
  }]), /same registration batch/);
  assert.deepEqual(registry.catalog().contributions, []);
});

test("Contribution Registry requires stable placement and fallback labels", () => {
  const registry = new ContributionRegistry();
  assert.throws(() => registry.register("builtin:invalid", {
    ...diagnosticsPage,
    surface: ""
  }), /surface/);
  assert.throws(() => registry.register("builtin:invalid", {
    ...diagnosticsPage,
    label: { fallback: "" }
  }), /label fallback/);
});

test("root Context disposal removes every plugin contribution", async () => {
  const host = new RabiCordisHost();
  await host.mount(contributionRegistryServicePlugin);
  const registry = host.context.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;
  await host.mount(contributionPlugin("builtin:first", pageBatch()));
  await host.mount(contributionPlugin("builtin:second", [restartCommand]));

  assert.equal(registry.catalog().contributions.length, 3);
  await host.dispose();
  assert.deepEqual(registry.catalog().contributions, []);
});

test("mounted Contribution runtime unmount preserves sibling Fibers", async () => {
  const host = new RabiCordisHost();
  let siblingActive = 0;
  await host.mount({
    name: "test:contribution-runtime-sibling",
    apply(ctx) {
      ctx.effect(() => {
        siblingActive += 1;
        return () => { siblingActive -= 1; };
      });
    }
  });

  const { mountContributionRuntime } = await import("./contributionRuntime.js");
  const runtime = await mountContributionRuntime(host, [
    contributionPlugin("builtin:mounted", sharedContributions)
  ]);
  assert.equal(runtime.registry.catalog().contributions.length, 5);

  await runtime.unmount();
  assert.deepEqual(runtime.registry.catalog().contributions, []);
  assert.equal(siblingActive, 1);

  await host.dispose();
  assert.equal(siblingActive, 0);
});
