/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  registerTrustedWebCommand,
  registeredWebCommands,
  resolveWebCommandCatalog,
  webCommandHandler,
  webCommandsInSlot
} from "./pluginCommands";
import { activateRouteControl } from "../../src/plugins/io.rabiroute.manager.route-control/web/contributions";
import { activateWebPluginForTest } from "../tests/web-plugin-test-host";

const disposeRouteControl = activateWebPluginForTest({ instanceId: "manager:route-control", pluginId: "io.rabiroute.manager.route-control" }, activateRouteControl);
test.after(() => disposeRouteControl());

function contribution(handlerId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "command",
    surface: "web.commands",
    id: "trusted-command",
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    hosts: ["web"],
    handlerId,
    slot: "utility-action",
    icon: "mdi-shield-check-outline",
    label: { fallback: "可信动作" },
    order: 20,
    ...overrides
  };
}

test("built-in Web commands use the trusted registration API", () => {
  assert.deepEqual(registeredWebCommands().map(command => [command.instanceId, command.pluginId, command.handlerId]), [
    ["manager:core", "io.rabiroute.manager.core", "web.save-page"],
    ["manager:route-control", "io.rabiroute.manager.route-control", "web.create-role"],
    ["manager:route-control", "io.rabiroute.manager.route-control", "web.add-route"],
    ["manager:route-control", "io.rabiroute.manager.route-control", "web.open-manager-config"]
  ]);
});

test("trusted command registration resolves catalog contributions and unregisters cleanly", () => {
  const handlerId = "trusted.web.command.v1";
  const dispose = registerTrustedWebCommand({
    instanceId: "manager:trusted",
    pluginId: "package:trusted",
    handlerId,
    allowedSlots: ["utility-action"],
    allowedIcons: ["mdi-shield-check-outline"],
    routeRoot: "/settings/models",
    execute: () => undefined
  });
  try {
    assert.equal(webCommandHandler(handlerId).handlerId, handlerId);
    const catalog = resolveWebCommandCatalog([contribution(handlerId, { routeRoot: "/untrusted" })]);
    assert.deepEqual(catalog.map(command => command.handlerId), [handlerId]);
    assert.deepEqual(webCommandsInSlot(catalog, "utility-action", "/settings/models"), catalog);
    assert.deepEqual(webCommandsInSlot(catalog, "utility-action", "/settings/models/speech"), catalog);
    assert.deepEqual(webCommandsInSlot(catalog, "utility-action", "/settings/models-extra"), []);
    assert.deepEqual(webCommandsInSlot(catalog, "utility-action", "/untrusted"), []);
    assert.deepEqual(resolveWebCommandCatalog([contribution(handlerId, { slot: "topbar-primary" })]), []);
    assert.deepEqual(resolveWebCommandCatalog([contribution(handlerId, { instanceId: "manager:other" })]), []);
    assert.deepEqual(resolveWebCommandCatalog([contribution(handlerId, { pluginId: "package:other" })]), []);
    assert.deepEqual(resolveWebCommandCatalog([contribution("trusted.web.unknown")]), []);
  } finally {
    dispose();
  }
  assert.deepEqual(resolveWebCommandCatalog([contribution(handlerId)]), []);
});

test("trusted command registration rejects duplicate handlers", () => {
  assert.throws(() => registerTrustedWebCommand({
    instanceId: "manager:route-control",
    pluginId: "io.rabiroute.manager.route-control",
    handlerId: "web.create-role",
    allowedSlots: ["utility-action"],
    allowedIcons: ["mdi-shield-check-outline"],
    execute: () => undefined
  }), /already registered/);
});

test("new and legacy Route Control packages show Add Route only in the routes area", () => {
  const commands = resolveWebCommandCatalog([contribution("web.add-route", {
    instanceId: "manager:route-control",
    pluginId: "io.rabiroute.manager.route-control",
    slot: "topbar-primary",
    icon: "mdi-plus"
  })]);
  assert.equal(commands[0]?.routeRoot, "/routes");
  for (const catalog of [commands, commands.map(command => ({ ...command, routeRoot: undefined }))]) {
    assert.deepEqual(webCommandsInSlot(catalog, "topbar-primary", "/routes/main"), catalog);
    assert.deepEqual(webCommandsInSlot(catalog, "topbar-primary", "/settings"), []);
  }
});
