import assert from "node:assert/strict";
import test from "node:test";
import { commonManagerOperations } from "./managerNativeOperations.js";
import type { AgentManagerImplementationOptions } from "../manager/agentManagerHostPorts.js";
import type { AgentManagerDescriptor } from "../manager/agentManagerProviders.js";

const descriptor: AgentManagerDescriptor = {
  type: "fixture", capability: "agent.adapter.fixture@1",
  manifest: { type: "fixture", label: "Fixture", maturity: "experimental", transport: { protocol: "fixture", mode: "owner" }, capabilities: {} },
  sessionBinding: { sessionId: "fixtureSessionId", sessionName: "fixtureSessionName", workspace: "fixtureCwd", defaultName: "Existing task" }
};

test("native binding changes preserve committed input, unrelated identities and strict boolean enabled semantics", async () => {
  const options = { host: { readOnly: () => false } } as AgentManagerImplementationOptions;
  const configure = commonManagerOperations(options, descriptor, new AbortController().signal)["binding.configure"]!;
  const definition = { agentAdapters: ["fixture", "other", "unknown-old"], fixtureSessionId: "original", otherSessionId: "untouched", unknown: { keep: true } };
  for (const enabled of ["true", "false", null, 0]) {
    const updated = await configure({ definition, body: { enabled, sessionId: "new" } }) as typeof definition;
    assert.deepEqual(updated.agentAdapters, definition.agentAdapters);
    assert.equal(updated.fixtureSessionId, "new");
    assert.equal(updated.otherSessionId, "untouched");
    assert.deepEqual(updated.unknown, { keep: true });
    assert.equal(definition.fixtureSessionId, "original");
  }
  const disabled = await configure({ definition, body: { enabled: false } }) as typeof definition;
  assert.deepEqual(disabled.agentAdapters, ["other", "unknown-old"]);
  const enabled = await configure({ definition: disabled, body: { enabled: true } }) as typeof definition;
  assert.deepEqual(enabled.agentAdapters, ["other", "unknown-old", "fixture"]);
  await assert.rejects(Promise.resolve().then(() => configure({ definition, body: { sessionId: "bad" } }, { assertCurrent() { throw new Error("original authority changed"); } })), /original authority changed/);
  assert.equal(definition.fixtureSessionId, "original");
});
