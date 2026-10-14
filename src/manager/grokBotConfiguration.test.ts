import assert from "node:assert/strict";
import test from "node:test";
import { encodeGrokBotSessionId } from "../agentAdapters/grokBotClient.js";
import { grokBotEndpointConfiguration } from "./grokBotConfiguration.js";

test("Grok endpoint selects the configured native profile by complete session identity", () => {
  const id = encodeGrokBotSessionId("owner-a", "session-a");
  const other = encodeGrokBotSessionId("owner-b", "session-b");
  const definitions = [
    { agentAdapters: ["grokBot"], grokBotAgentId: "owner-b", grokBotSessionId: other, grokBotProfilePath: "C:/profiles/b" },
    { agentAdapters: ["grokBot"], grokBotAgentId: "owner-a", grokBotSessionId: id, grokBotProfilePath: "C:/profiles/a" }
  ];
  assert.equal(grokBotEndpointConfiguration(definitions, id).profilePath, "C:/profiles/a");
  assert.equal(grokBotEndpointConfiguration(definitions, other).profilePath, "C:/profiles/b");
});

test("duplicate matching routes cannot silently replace a native owner profile", () => {
  const id = encodeGrokBotSessionId("owner", "session");
  const base = { agentAdapters: ["grokBot"], grokBotAgentId: "owner", grokBotSessionId: id };
  assert.throws(() => grokBotEndpointConfiguration([
    { ...base, grokBotProfilePath: "C:/profiles/a" }, { ...base, grokBotProfilePath: "C:/profiles/b" }
  ], id), /GROK_BOT_PROFILE_CONFIGURATION_CONFLICT/);
  assert.throws(() => grokBotEndpointConfiguration([{ ...base, grokBotAgentId: "other" }], id), /GROK_BOT_SESSION_OWNER_MISMATCH/);
  assert.equal(grokBotEndpointConfiguration([{ ...base, grokBotProfilePath: "C:/profiles/a" }, { ...base, grokBotProfilePath: "C:/profiles/a" }], id).profilePath, "C:/profiles/a");
});
