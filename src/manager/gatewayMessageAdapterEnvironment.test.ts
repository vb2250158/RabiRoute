import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import { gatewayEndpointTypesFromManifests, isGatewayMessageAdapterType } from "../shared/messageEndpointTypes.js";
import {
  gatewayAdapterTypes,
  gatewayMessageAdapterTypes,
  type GatewayDefinition
} from "../shared/gatewayConfigModel.js";
import { gatewayMessageAdapterEnvironment, routeMessageAdapterEnvironment } from "./gatewayMessageAdapterEnvironment.js";
import { gatewayRuntimeStartDecision, gatewayRuntimeSyncAction } from "./managerRuntimeMode.js";

const profile = JSON.parse(await fs.readFile(path.resolve("plugins/profiles/desktop.json"), "utf8")) as {instances: Array<{package: string; version: string}>};
const declaredGatewayTypes = gatewayEndpointTypesFromManifests(await Promise.all(profile.instances.map(async instance =>
  parsePluginManifest(JSON.parse(await fs.readFile(path.resolve("src/plugins", instance.package, "rabi.plugin.json"), "utf8"))))));

function route(messageAdapters: GatewayDefinition["messageAdapters"]): GatewayDefinition {
  return {
    id: "Rabi__projection",
    name: "Projection",
    enabled: true,
    gatewayPort: 8789,
    messageAdapters
  };
}

test("pure Manager-owned message endpoints do not require a resident Gateway", () => {
  for (const type of ["speech", "rolePanel", "wearable", "remoteAgent"] as const) {
    const runtimeRequired = gatewayMessageAdapterTypes(route([type]), declaredGatewayTypes).length > 0;
    assert.equal(runtimeRequired, false, type);
    assert.equal(gatewayRuntimeSyncAction({
      managerShouldAutostart: true,
      enabled: true,
      runtimeRequired,
      running: false,
      needsRestart: false
    }), "none", type);
    assert.equal(gatewayRuntimeStartDecision({
      enabled: true,
      runtimeRequired,
      running: false
    }), "skip-not-required", type);
  }
});

test("resident Gateway environment contains only Gateway-owned adapter types", () => {
  const definition = route(["speech", "rabilink", "wearable", "remoteAgent"]);
  assert.deepEqual(gatewayMessageAdapterEnvironment(gatewayMessageAdapterTypes(definition, declaredGatewayTypes)), {
    MESSAGE_ADAPTER_TYPE: "rabilink",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(["rabilink"])
  });
});

test("new endpoint IDs inherit host ownership from their actual package declarations", () => {
  const type = "org.example.custom-channel";
  const manifest = {entries: {gateway: {execution: "in_process", module: "./gateway.mjs"}}, provides: [`endpoint.${type}@1`]};
  const gatewayTypes = gatewayEndpointTypesFromManifests([manifest]);
  assert.deepEqual(gatewayMessageAdapterTypes(route(["speech", type]), gatewayTypes), [type]);
  assert.equal(isGatewayMessageAdapterType(type, gatewayTypes), true);
  assert.equal(isGatewayMessageAdapterType(type, gatewayEndpointTypesFromManifests([{...manifest, entries: {}}])), false);
  assert.deepEqual(gatewayMessageAdapterTypes(route([type]), new Set()), []);
  assert.deepEqual([...gatewayEndpointTypesFromManifests([{...manifest, provides: [`endpoint.${type}@1`, `endpoint.${type}.egress@1`]}])], [type]);
  assert.deepEqual([...gatewayEndpointTypesFromManifests([{...manifest, provides: [`endpoint.${type}.egress@1`, `endpoint.${type}.egress.egress@1`]}])], [`${type}.egress`]);
});

test("one-shot environment preserves the Route's complete active message endpoints", () => {
  const definition = route(["speech", "rabilink", "wearable", "remoteAgent"]);
  assert.deepEqual(routeMessageAdapterEnvironment(gatewayAdapterTypes(definition)), {
    MESSAGE_ADAPTER_TYPE: "speech",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(["speech", "rabilink", "wearable", "remoteAgent"])
  });
});

test("an empty adapter projection uses the legacy disabled sentinel instead of NapCat", () => {
  assert.deepEqual(routeMessageAdapterEnvironment([]), {
    MESSAGE_ADAPTER_TYPE: "disabled",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(["disabled"])
  });
});
