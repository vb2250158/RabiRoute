/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import {
  registerTrustedWebCommand,
  registeredWebCommands,
  resolveWebCommandCatalog,
  webCommandHandler
} from "./pluginCommands";

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
    ["manager:route-control", "builtin:manager/route-control", "web.quick-setup"],
    ["manager:route-control", "builtin:manager/route-control", "web.add-route"],
    ["manager:route-control", "builtin:manager/route-control", "web.open-manager-config"],
    ["manager:core", "builtin:manager/core", "web.save-page"]
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
    execute: () => undefined
  });
  try {
    assert.equal(webCommandHandler(handlerId).handlerId, handlerId);
    assert.deepEqual(resolveWebCommandCatalog([contribution(handlerId)]).map(command => command.handlerId), [handlerId]);
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
    pluginId: "builtin:manager/route-control",
    handlerId: "web.quick-setup",
    allowedSlots: ["utility-action"],
    allowedIcons: ["mdi-shield-check-outline"],
    execute: () => undefined
  }), /already registered/);
});
