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

test("scan sends configuration snapshots without live runtime handles to the worker", async () => {
  const definition = { id: "route", workbuddyCwd: "C:/work/project" };
  const runtime = { definition, process: { send() {} }, onExit() {} };
  const options = {
    scannerEntry: "C:/packages/fixture/scan.mjs",
    host: {
      rootDir: "C:/state", packageRoot: "C:/packages",
      getRuntimes: () => [runtime],
      async runScan(task: unknown) {
        const snapshot = structuredClone(task) as { runtimes: unknown[] };
        assert.deepEqual(snapshot.runtimes, [{ definition }]);
        return { agents: {}, cwdOptions: [] };
      }
    }
  } as unknown as AgentManagerImplementationOptions;
  const scan = commonManagerOperations(options, descriptor, new AbortController().signal).scan!;
  assert.deepEqual(await scan({}), { agents: {}, cwdOptions: [] });
  assert.equal(typeof runtime.process.send, "function");
});

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
