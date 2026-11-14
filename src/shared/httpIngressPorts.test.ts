import assert from "node:assert/strict";
import test from "node:test";
import { autoAssignGatewayPorts, collectGatewayPortClaims, normalizeGatewayDefinition, type GatewayDefinition } from "./gatewayConfigModel.js";

test("named HTTP ingress defaults and saved zeros remain dynamic through normalization and allocation", () => {
  for (const [type, key] of [["rabilink", "rabiLinkWebhookPort"], ["feishu", "feishuWebhookPort"], ["xiaoai", "xiaoaiWebhookPort"]] as const) {
    const raw: GatewayDefinition = { id: type, gatewayPort: 23456, napcatHttpUrl: "http://127.0.0.1:3000", messageAdapters: [type] };
    const unassigned = { ...raw, [key]: undefined };
    autoAssignGatewayPorts([unassigned], 23456);
    assert.equal(unassigned[key], 0);
    const normalized = normalizeGatewayDefinition(raw);
    // Each absent or zero preference stays automatic in the shared configuration owner.
    assert.equal(normalized[key], 0);
    autoAssignGatewayPorts([normalized], 23456);
    assert.equal(normalized[key], 0);
    assert.equal(collectGatewayPortClaims([normalized]).length, 0);
    const explicit = normalizeGatewayDefinition({ ...raw, [key]: 23457 });
    autoAssignGatewayPorts([explicit], 23456);
    assert.equal(explicit[key], 23457);
    assert.equal(collectGatewayPortClaims([explicit])[0]?.port, 23457);
    assert.throws(() => normalizeGatewayDefinition({ ...raw, [key]: -1 }), /port/i);
  }
});
