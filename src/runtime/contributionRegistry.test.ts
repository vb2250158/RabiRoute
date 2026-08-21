import assert from "node:assert/strict";
import test from "node:test";
import { ContributionRegistry } from "./contributionRegistry.js";
import {
  CONTRIBUTION_REGISTRY_SERVICE,
  contributionPlugin,
  contributionRegistryServicePlugin
} from "./contributionRuntime.js";
import { RabiCordisHost } from "./cordisHost.js";

const sharedContributions = [
  {
    kind: "navigation" as const,
    id: "diagnostics",
    labelKey: "nav.diagnostics",
    target: "/diagnostics",
    hosts: ["web"] as const,
    order: 20
  },
  {
    kind: "command" as const,
    id: "restart-gateway",
    labelKey: "command.restartGateway",
    action: { method: "POST" as const, endpoint: "/api/gateways/restart" },
    hosts: ["web", "desktop"] as const,
    order: 10
  },
  {
    kind: "tray-menu" as const,
    id: "restart-gateway-menu",
    commandId: "restart-gateway",
    hosts: ["desktop"] as const,
    order: 30
  }
];

test("Contribution Registry filters one shared catalog by host and order", async () => {
  const host = new RabiCordisHost();
  await host.mount(contributionRegistryServicePlugin);
  const fiber = await host.mount(contributionPlugin("builtin:diagnostics", sharedContributions));
  const registry = host.context.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;

  assert.deepEqual(
    registry.catalog("web").contributions.map((item) => `${item.kind}:${item.id}`),
    ["command:restart-gateway", "navigation:diagnostics"]
  );
  assert.deepEqual(
    registry.catalog("desktop").contributions.map((item) => `${item.kind}:${item.id}`),
    ["command:restart-gateway", "tray-menu:restart-gateway-menu"]
  );
  assert.equal(registry.catalog().contributions.every((item) => item.pluginId === "builtin:diagnostics"), true);

  const revisionAfterRegister = registry.catalog().revision;
  await fiber.dispose();
  assert.deepEqual(registry.catalog().contributions, []);
  assert.equal(registry.catalog().revision, revisionAfterRegister + 1);
  await host.dispose();
});

test("Contribution Registry rejects duplicate keys atomically", () => {
  const registry = new ContributionRegistry();
  registry.register("builtin:first", sharedContributions[0]);

  assert.throws(() => registry.registerMany("builtin:second", [
    sharedContributions[1],
    {
      kind: "navigation",
      id: "diagnostics",
      labelKey: "nav.other",
      target: "/other",
      hosts: ["web"]
    }
  ]), /Contribution already registered: navigation:diagnostics/);

  assert.deepEqual(
    registry.catalog().contributions.map((item) => `${item.kind}:${item.id}`),
    ["navigation:diagnostics"]
  );
});

test("root Context disposal removes every plugin contribution", async () => {
  const host = new RabiCordisHost();
  await host.mount(contributionRegistryServicePlugin);
  const registry = host.context.get(CONTRIBUTION_REGISTRY_SERVICE, true) as ContributionRegistry;
  await host.mount(contributionPlugin("builtin:first", [sharedContributions[0]]));
  await host.mount(contributionPlugin("builtin:second", [sharedContributions[1]]));

  assert.equal(registry.catalog().contributions.length, 2);
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
  assert.equal(runtime.registry.catalog().contributions.length, 3);

  await runtime.unmount();
  assert.deepEqual(runtime.registry.catalog().contributions, []);
  assert.equal(siblingActive, 1);

  await host.dispose();
  assert.equal(siblingActive, 0);
});
