import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayAdapterTypes,
  gatewayMessageAdapterTypes,
  type GatewayDefinition
} from "../shared/gatewayConfigModel.js";
import { gatewayMessageAdapterEnvironment, routeMessageAdapterEnvironment } from "./gatewayMessageAdapterEnvironment.js";
import { gatewayRuntimeStartDecision, gatewayRuntimeSyncAction } from "./managerRuntimeMode.js";

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
    const runtimeRequired = gatewayMessageAdapterTypes(route([type])).length > 0;
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
  assert.deepEqual(gatewayMessageAdapterEnvironment(gatewayMessageAdapterTypes(definition)), {
    MESSAGE_ADAPTER_TYPE: "rabilink",
    MESSAGE_ADAPTER_TYPES: JSON.stringify(["rabilink"])
  });
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
