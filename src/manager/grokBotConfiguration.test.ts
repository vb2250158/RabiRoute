import assert from "node:assert/strict";
import test from "node:test";
import { encodeGrokBotSessionId } from "../agentAdapters/grokBotClient.js";
import { normalizeGatewayDefinition } from "../shared/gatewayConfigModel.js";
import { grokBotEndpointConfiguration } from "./grokBotConfiguration.js";

test("Grok endpoint verifies complete owner identity and ignores retired connection overrides", () => {
  const id = encodeGrokBotSessionId("owner-a", "session-a");
  const other = encodeGrokBotSessionId("owner-b", "session-b");
  const definitions = [
    { agentAdapters: ["grokBot"], grokBotAgentId: "owner-b", grokBotSessionId: other, grokBotProfilePath: "C:/profiles/b" },
    { agentAdapters: ["grokBot"], grokBotAgentId: "owner-a", grokBotSessionId: id, grokBotProfilePath: "C:/profiles/a" }
  ];
  assert.deepEqual(grokBotEndpointConfiguration(definitions, id), {});
  assert.deepEqual(grokBotEndpointConfiguration(definitions, other), {});
});

test("retired profile overrides do not conflict, while a mismatched owner still fails closed", () => {
  const id = encodeGrokBotSessionId("owner", "session");
  const base = { agentAdapters: ["grokBot"], grokBotAgentId: "owner", grokBotSessionId: id };
  assert.deepEqual(grokBotEndpointConfiguration([
    { ...base, grokBotProfilePath: "C:/profiles/a" }, { ...base, grokBotProfilePath: "C:/profiles/b" }
  ], id), {});
  assert.throws(() => grokBotEndpointConfiguration([{ ...base, grokBotAgentId: "other" }], id), /GROK_BOT_SESSION_OWNER_MISMATCH/);
  assert.deepEqual(grokBotEndpointConfiguration([{ ...base, grokBotProfilePath: "C:/profiles/a" }, { ...base, grokBotProfilePath: "C:/profiles/a" }], id), {});
});


test("Route normalization retires connection paths while preserving the exact selected Bot", () => {
  const id = encodeGrokBotSessionId("owner", "", { defaultMain: true });
  const normalized = normalizeGatewayDefinition({ id: "example", gatewayPort: 18001, agentAdapters: ["grokBot"],
    grokBotAgentId: "owner", grokBotSessionId: id, grokBotSessionName: "Example Bot",
    grokBotProfilePath: "C:/retired-profile", grokBotBackendUrl: "https://retired.invalid/" });
  assert.equal(normalized.grokBotProfilePath, undefined);
  assert.equal(normalized.grokBotBackendUrl, undefined);
  assert.equal(normalized.grokBotAgentId, "owner");
  assert.equal(normalized.grokBotSessionId, id);
});
