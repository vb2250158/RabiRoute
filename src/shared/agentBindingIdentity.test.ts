import assert from "node:assert/strict";
import test from "node:test";
import { installAgentAdapterManifestReader, isPlanAssistantAgentType, normalizePlanBindingAgentType } from "./agentAdapterCapabilities.js";
test("persisted third-party binding identity survives disabled plugins and metadata-only workers", () => {
    const restore = installAgentAdapterManifestReader(() => []);
    try {
        assert.equal(normalizePlanBindingAgentType("thirdParty.adapter"), "thirdParty.adapter");
        assert.equal(normalizePlanBindingAgentType("dsh"), "dsh");
        assert.equal(isPlanAssistantAgentType("thirdParty.adapter"), false, "A readable identity does not authorize a new assistant.");
        assert.equal(normalizePlanBindingAgentType(undefined), "codex", "Only absent legacy identities use the original Codex default.");
        assert.throws(() => normalizePlanBindingAgentType("invalid identity"), /Invalid/);
        assert.throws(() => normalizePlanBindingAgentType({ type: "dsh" }), /Invalid/);
    }
    finally {
        restore();
    }
});
