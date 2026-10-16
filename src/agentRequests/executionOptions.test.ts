import test from "node:test";
import assert from "node:assert/strict";
import { endpointExecutionOptionsHash, normalizeEndpointExecutionOptions } from "./executionOptions.js";

test("group identity execution options survive normalization and have canonical property ordering", () => {
  const grokBotDelivery = { deliveryType: "group", sendMode: "identity", senderAgentId: "fixture-sender" };
  assert.deepEqual(normalizeEndpointExecutionOptions({ grokBotDelivery }), { grokBotDelivery });
  assert.equal(endpointExecutionOptionsHash({ grokBotDelivery }), endpointExecutionOptionsHash({
    grokBotDelivery: { senderAgentId: "fixture-sender", sendMode: "identity", deliveryType: "group" } }));
});

test("execution hash distinguishes sender identity, direct mode, target kind and legacy options", () => {
  const options = [
    {},
    { grokBotDelivery: { deliveryType: "group", sendMode: "identity", senderAgentId: "fixture-sender" } },
    { grokBotDelivery: { deliveryType: "group", sendMode: "identity", senderAgentId: "fixture-other" } },
    { grokBotDelivery: { deliveryType: "group", sendMode: "direct" } },
    { grokBotDelivery: { deliveryType: "private", sendMode: "direct" } }
  ];
  assert.equal(new Set(options.map(endpointExecutionOptionsHash)).size, options.length);
  assert.deepEqual(normalizeEndpointExecutionOptions(options[3]), options[3]);
});

test("identity execution options reject missing sender and invalid delivery modes instead of silently dropping fields", () => {
  for (const grokBotDelivery of [
    { deliveryType: "group", sendMode: "identity" },
    { deliveryType: "group", sendMode: "direct", senderAgentId: "fixture-sender" },
    { deliveryType: "invalid", sendMode: "direct" },
    { deliveryType: "group", sendMode: "invalid" },
    { deliveryType: "group", sendMode: "identity", senderAgentId: "" }
  ]) assert.throws(() => normalizeEndpointExecutionOptions({ grokBotDelivery }));
});
