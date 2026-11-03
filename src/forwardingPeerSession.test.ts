import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { isPlanAssistantAgentType } from "./shared/agentAdapterCapabilities.js";
import { remoteAgentTargetKey, resolvePrimaryAgentTarget, peerRouteAgentSession } from "./shared/routeAgentTargets.js";

/** Execute the real selectors/dispatch body with a closed, injected delivery boundary. No source imports can reach a live owner. */
function functions(file: string, names: string[], context: Record<string, unknown>) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declarations = names.map(name => {
    const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(declaration, `Missing function ${name}`); return declaration.getText(parsed);
  }).join("\n");
  const code = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(`(function(){${code}\nreturn {${names.join(",")}};})()`, context);
}

function peerConfig(provider: "codex" | "dsh") {
  const target = { provider, ownerDeviceId: "fixture-peer-b", instanceId: "fixture-instance-b", agentId: provider,
    sessionId: "peer-b-full-session", sessionName: "B task", workspace: "/peer-b/workspace", id: "" };
  target.id = remoteAgentTargetKey(target);
  return { config: { agentAdapters: [provider], primaryAgentTarget: target.id, remoteAgentTargets: [target],
    codexThreadId: "local-a-codex", codexThreadName: "Local Codex", codexCwd: "/local-a/codex",
    dshSessionId: "local-a-dsh", dshSessionName: "Local DSH", dshCwd: "/local-a/dsh", dataDir: "/fixture-state" }, target };
}

for (const provider of ["codex", "dsh"] as const) {
  test(`gateway ${provider} dispatch passes the selected peer session/workspace to its adapter`, async () => {
    const { config, target } = peerConfig(provider);
    const calls: Array<{ provider: string; target: unknown; options: { threadId?: string; workspace?: string } }> = [];
    const methods = functions("./forwarding.ts", ["dispatchToAgentAdapter"], {
      config, PERFORMANCE_OPERATIONS: { gatewayAgentDeliver: "fixture.deliver" },
      measurePerformanceOperation: (_name: string, run: () => unknown) => run(),
      createAgentAdapter: async (provider: string, selected: unknown) => ({ deliver: async (_envelope: unknown, options: { threadId?: string; workspace?: string }) => { calls.push({ provider, target: selected, options }); } })
    });
    await methods.dispatchToAgentAdapter(provider, { messageContent: "isolated fixture" }, [], resolvePrimaryAgentTarget(config));
    assert.equal(calls.length, 1); assert.equal(calls[0].provider, provider);
    assert.equal(calls[0].options.threadId, target.sessionId); assert.equal(calls[0].options.workspace, target.workspace);
    assert.equal(JSON.stringify(calls[0].target), JSON.stringify({ binding: { instanceId: target.instanceId, agentId: target.agentId, ownerDeviceId: target.ownerDeviceId } }));
    config.primaryAgentTarget = `local:${provider}`;
    await methods.dispatchToAgentAdapter(provider, {}, [], resolvePrimaryAgentTarget(config));
    assert.equal(calls[1].target, "local");
    assert.equal(calls[1].options.threadId, provider === "codex" ? config.codexThreadId : config.dshSessionId);
  });

  test(`peer ${provider} worker uses its target reference and never borrows a missing session from local defaults`, async () => {
    const { config, target } = peerConfig(provider);
    const methods = functions("./forwarding.ts", ["primaryManagedAgentBinding", "configuredPrimaryAgentAdapter", "managedAgentExecution"], {
      config, resolvePrimaryAgentTarget, peerRouteAgentSession, isPlanAssistantAgentType,
      instanceWorkerStateDirectory: (_dataDir: string, _binding: unknown, sessionId: string) => `/isolated/${sessionId}`,
      requestInstanceThread: async () => { throw new Error("Unexpected transport execution in selector test."); }
    });
    const execution = await methods.managedAgentExecution();
    assert.equal(execution.binding.sessionId, target.sessionId); assert.equal(execution.binding.workspace, target.workspace);
    assert.equal(execution.binding.agentAdapter, provider); assert.equal(execution.dataDir, `/isolated/${target.sessionId}`);
    config.remoteAgentTargets = [{ ...target, sessionId: "", workspace: "" }];
    assert.equal(methods.primaryManagedAgentBinding(), undefined);
    await assert.rejects(methods.managedAgentExecution(), /full session ID and workspace/);
  });
}

test("local Agent catalog fields stay local while the primary peer uses its own session reference", () => {
  const { config } = peerConfig("codex");
  const methods = functions("./manager/controlPlaneRoutes.ts", ["configuredLocalAgentSessionFields", "primaryAgentSessionFields"], { peerRouteAgentSession });
  assert.equal(methods.configuredLocalAgentSessionFields(config, "codex").sessionId, "local-a-codex");
  assert.equal(methods.configuredLocalAgentSessionFields(config, "codex").workspace, "/local-a/codex");
  assert.equal(methods.primaryAgentSessionFields(config, "codex").sessionId, "peer-b-full-session");
  assert.equal(methods.primaryAgentSessionFields(config, "codex").workspace, "/peer-b/workspace");
});
