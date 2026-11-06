import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { EndpointDeliveryNotSentError } from "@rabiroute/host-api/agentRequests/deliveryFailure";
const { bundleMessageEndpointRuntime } = await import(pathToFileURL(path.resolve(import.meta.dirname, "../../scripts/build-message-endpoint-runtime.mjs")).href);

test("the real package bundle shares its runtime, error class, receipt map and event subscription", async t => {
  const root = process.cwd(), prefix = "src/plugins/io.rabiroute.agent.codex/src/";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-owner-bundle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "runtime.mjs");
  const specification = JSON.parse(await fs.readFile(path.join(root, "src/plugins/io.rabiroute.agent.codex/manager-runtime.build.json"), "utf8"));
  const bundle = await bundleMessageEndpointRuntime(root, { ...specification, exports: [
    ...specification.exports,
    { source: prefix + "codexRuntime.ts", name: "createCodexRuntime" },
    ...["CodexDesktopBridge", "CodexDesktopPromptNotSentError", "noteCodexDesktopLateStartForTest"].map(name => ({ source: prefix + "codexDesktopBridge.ts", name })),
    ...["executeEndpointOnOwner", "recoverEndpointOwnerReceipt"].map(name => ({ source: prefix + "agentAdapters/codexOwnerExecution.ts", name }))
  ] }, output);
  assert.equal(bundle.hostModules.some((id: string) => id === "codexRuntime" || id.startsWith("plugins/io.rabiroute.agent.codex/")), false);
  const modules = new Map(await Promise.all(bundle.hostModules.map(async (id: string) =>
    [id, await import(pathToFileURL(path.join(root, "src", id + ".ts")).href)] as const)));
  const environment = { CODEX_HOME: directory, CODEX_SQLITE_HOME: directory };
  const implementation = (await import(pathToFileURL(output).href)).createImplementation({ environment, module(id: string) { return modules.get(id); } });
  const database = new DatabaseSync(path.join(directory, "state_5.sqlite"));
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, updated_at_ms INTEGER, recency_at INTEGER, recency_at_ms INTEGER, archived INTEGER, first_user_message TEXT)");
  database.prepare("INSERT INTO threads VALUES (?, ?, ?, '', 1, 1000, 1, 1000, 0, '')").run("original-owner", "Original task", directory);
  database.close();
  let attempts = 0, closes = 0;
  const runtime = implementation.createCodexRuntime({ createDesktopBridge: () => ({ close() { closes++; }, async isReady() { return true; },
    threadActiveSince() { return null; }, async deliver() { attempts++; throw new implementation.CodexDesktopPromptNotSentError(new Error("Fixture zero frames")); } }) });
  const events: Array<{ type: string; data: any }> = [];
  const owner = implementation.createManager({ host: { publishManagerEvent(type: string, data: unknown) { events.push({ type, data }); } } },
    { type: "codex", capability: "agent.adapter.codex@1", manifest: { type: "codex", label: "Codex", maturity: "experimental", transport: { protocol: "fixture", mode: "owner" }, capabilities: {} }, sessionBinding: {} }, new AbortController().signal);
  const bridge = new implementation.CodexDesktopBridge();
  t.after(async () => { bridge.close(); await owner.dispose(); await runtime.disposeCodexAdapterTransport(); });
  await owner.start();
  const delivery = { deliveryId: "11111111-aaaa-4bbb-8ccc-111111111171", generation: "original-generation", target: { provider: "codex", sessionId: "original-owner" },
    prompt: "Fixture only", promptHash: "original-hash", executionOptionsHash: "original-options", executionOptions: { cwd: directory } };
  await assert.rejects(implementation.executeEndpointOnOwner(delivery, {}, () => {}, { sendCodex: runtime.sendCodexThreadMessage }),
    (error: unknown) => error instanceof EndpointDeliveryNotSentError);
  assert.equal(attempts, 1);
  const differentWorkspace = path.join(directory, 'another-workspace');
  await fs.mkdir(differentWorkspace);
  await assert.rejects(implementation.executeEndpointOnOwner({ ...delivery, executionOptions: { cwd: differentWorkspace } }, {}, () => {},
    { sendCodex: runtime.sendCodexThreadMessage }), (error: any) => {
      assert.equal(error.code, 'AGENT_WORKSPACE_MISMATCH'); assert.equal(error.field, 'cwd');
      assert.match(error.repair, /action.*read/); assert.match(error.repair, /\/api\/lan-agent\/instances/);
      assert.doesNotMatch(error.message + error.repair, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  assert.equal(attempts, 1, 'Workspace diagnostic cannot send a prompt or substitute its cwd.');
  assert.equal(await implementation.recoverEndpointOwnerReceipt(delivery, () => {}), undefined);
  bridge.confirmLateStart({ threadId: "original-owner", prompt: `本次投递 deliveryId：${delivery.deliveryId}`, cwd: directory, sandbox: "workspace-write" }, "original-ipc-id");
  assert.equal((await implementation.recoverEndpointOwnerReceipt(delivery, () => {}))?.deliveryId, delivery.deliveryId);
  assert.equal(events.filter(item => item.type === "agent.delivery-receipt" && item.data.late && item.data.deliveryMarker === delivery.deliveryId).length, 1);
  await owner.unpublish();
  const count = events.length;
  bridge.confirmLateStart({ threadId: "original-owner", prompt: "本次投递 deliveryId：11111111-aaaa-4bbb-8ccc-111111111172", cwd: directory, sandbox: "workspace-write" }, "another-ipc-id");
  assert.equal(events.length, count);
  await runtime.disposeCodexAdapterTransport();
  await runtime.disposeCodexAdapterTransport();
  assert.equal(closes, 1);
  assert.equal(attempts, 1, "receipt observation does not submit another body");
});
