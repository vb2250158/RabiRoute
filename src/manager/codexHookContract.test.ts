import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexHookContextService } from "./codexHookContext.js";
import { CODEX_HOOK_OPERATIONS, codexHookOperationContract } from "./codexHookContract.js";
import { ApiContractError, compileApiContract, validateApiOperationResult } from "./apiOperationContract.js";

function doctorFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-hook-doctor-contract-"));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const rolesRoot = path.join(root, "roles"), storePath = path.join(root, "hooks.json");
  fs.mkdirSync(path.join(rolesRoot, "Fixture"), { recursive: true });
  fs.writeFileSync(path.join(rolesRoot, "Fixture/persona.md"), "# Public fixture\n");
  const updatedAt = "2026-01-01T00:00:00.000Z";
  const local = { sessionId: "fixture-local", roleId: "Fixture", planId: "fixture-plan", turnId: "fixture-turn", updatedAt, status: "sent" };
  const remoteWithoutAgent = { ...local, sessionId: "fixture-remote-cli", agentType: "codex", sourceInstance: { instanceId: "fixture-node" } };
  const remoteWithAgent = { ...local, sessionId: "fixture-remote-agent", agentType: "dsh", sourceInstance: { instanceId: "fixture-node", ownerDeviceId: "fixture-peer", agentId: "fixture-agent" } };
  fs.writeFileSync(storePath, JSON.stringify({ version: 8, sessions: {
    remote: { sessionId: remoteWithAgent.sessionId, roleId: "Fixture", createdAt: updatedAt, updatedAt, agentType: "dsh", sourceInstance: remoteWithAgent.sourceInstance }
  }, planTaskCompletions: { local, remoteWithoutAgent, remoteWithAgent }, projectFileChanges: {}, projectFileChangeReminders: {} }));
  const service = new CodexHookContextService({ rolesRoot: () => rolesRoot, storePath });
  const operation = compileApiContract({ contract: codexHookOperationContract(CODEX_HOOK_OPERATIONS.find(item => item.key === "doctor")!) });
  return { data: service.doctor(), operation, completions: [local, remoteWithoutAgent, remoteWithAgent], updatedAt };
}

test("doctor validates actual persisted local and remote completion DTOs without requiring an Agent ID for CLI ingress", t => {
  const f = doctorFixture(t);
  assert.deepEqual(f.data.planTaskCompletions, f.completions);
  assert.deepEqual(f.data.bindings, [{ sessionId: "fixture-remote-agent", roleId: "Fixture", updatedAt: f.updatedAt }]);
  assert.doesNotThrow(() => validateApiOperationResult(f.operation, { status: 200, body: { code: 0, data: f.data } }));
});

test("doctor still rejects unknown completion/source fields and malformed source coordinates", t => {
  const f = doctorFixture(t);
  const invalid = (completion: Record<string, unknown>) => {
    assert.throws(() => validateApiOperationResult(f.operation, { status: 200, body: { code: 0, data: {
      ...f.data, planTaskCompletions: [completion]
    } } }), error => error instanceof ApiContractError && error.status === 500 && error.code === "API_RESPONSE_SCHEMA_INVALID");
  };
  invalid({ ...f.completions[1], unexpected: true });
  invalid({ ...f.completions[1], sourceInstance: { instanceId: "fixture-node", unexpected: true } });
  invalid({ ...f.completions[1], sourceInstance: {} });
  invalid({ ...f.completions[1], sourceInstance: { instanceId: 12 } });
});
