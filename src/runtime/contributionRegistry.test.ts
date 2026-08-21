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
    label: { key: "nav.diagnostics", fallback: "Diagnostics" },
    target: "/diagnostics",
    hosts: ["web"] as const,
    surface: "web.navigation",
    slot: "utility",
    order: 20
  },
  {
    kind: "command" as const,
    id: "restart-gateway",
    label: { key: "command.restartGateway", fallback: "Restart gateway" },
    action: {
      method: "POST" as const,
      endpoint: "/api/gateways/restart",
      body: { options: { force: false } }
    },
    hosts: ["web", "desktop"] as const,
    surface: "manager.commands",
    slot: "gateway",
    requiredCapabilities: ["gateway.manage"] as const,
    order: 10
  },
  {
    kind: "tray-menu" as const,
    id: "restart-gateway-menu",
    label: { key: "tray.restartGateway", fallback: "Restart gateway" },
    commandId: "restart-gateway",
    hosts: ["desktop"] as const,
    surface: "desktop.tray",
    slot: "actions",
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

test("Contribution Registry rejects duplicate keys atomically", () => {
  const registry = new ContributionRegistry();
  registry.register("builtin:first", sharedContributions[0]);

  assert.throws(() => registry.registerMany("builtin:second", [
    sharedContributions[1],
    {
      kind: "navigation",
      id: "diagnostics",
      label: { fallback: "Other" },
      target: "/other",
      hosts: ["web"],
      surface: "web.navigation",
      slot: "utility"
    }
  ]), /Contribution already registered: navigation:diagnostics/);

  assert.deepEqual(
    registry.catalog().contributions.map((item) => `${item.kind}:${item.id}`),
    ["navigation:diagnostics"]
  );
});

test("Contribution Registry normalizes identities before duplicate checks and storage", () => {
  const registry = new ContributionRegistry();
  registry.register(" package:diagnostics ", {
    ...sharedContributions[0],
    id: " diagnostics ",
    surface: " web.navigation ",
    slot: " utility ",
    label: { key: " nav.diagnostics ", fallback: " Diagnostics " },
    requiredCapabilities: [" diagnostics.read "]
  }, " manager:diagnostics ");

  const contribution = registry.catalog().contributions[0];
  assert.equal(contribution?.id, "diagnostics");
  assert.equal(contribution?.surface, "web.navigation");
  assert.equal(contribution?.slot, "utility");
  assert.deepEqual(contribution?.label, { key: "nav.diagnostics", fallback: "Diagnostics" });
  assert.deepEqual(contribution?.requiredCapabilities, ["diagnostics.read"]);
  assert.equal(contribution?.pluginId, "package:diagnostics");
  assert.equal(contribution?.instanceId, "manager:diagnostics");

  assert.throws(() => registry.register("package:other", sharedContributions[0]), /already registered/);
  assert.throws(() => registry.register("package:capabilities", {
    ...sharedContributions[1],
    id: "duplicate-capability",
    requiredCapabilities: ["gateway.manage", " gateway.manage "]
  }), /required capabilities contain duplicates/);
});

test("Contribution Registry deep-clones nested contribution data", () => {
  const registry = new ContributionRegistry();
  const source = sharedContributions[1];
  assert.ok(source.kind === "command");
  registry.register("builtin:commands", source, "manager:commands");

  const first = registry.catalog().contributions.find(item => item.kind === "command");
  assert.ok(first?.kind === "command");
  (first.action.body as { options: { force: boolean } }).options.force = true;
  first.label.fallback = "Changed";
  (first.requiredCapabilities as string[]).push("private.capability");

  const second = registry.catalog().contributions.find(item => item.kind === "command");
  assert.ok(second?.kind === "command");
  assert.deepEqual(second.action.body, { options: { force: false } });
  assert.equal(second.label.fallback, "Restart gateway");
  assert.deepEqual(second.requiredCapabilities, ["gateway.manage"]);
  assert.deepEqual(source.action.body, { options: { force: false } });
});

test("Contribution Registry requires stable placement and fallback labels", () => {
  const registry = new ContributionRegistry();
  assert.throws(() => registry.register("builtin:invalid", {
    ...sharedContributions[0],
    surface: ""
  }), /surface/);
  assert.throws(() => registry.register("builtin:invalid", {
    ...sharedContributions[0],
    label: { fallback: "" }
  }), /label fallback/);
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
