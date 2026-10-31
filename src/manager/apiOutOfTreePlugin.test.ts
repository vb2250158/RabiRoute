import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";
import { ManagerPluginRouteRegistry, createManagerApiOperationsService } from "./managerPluginRouteRegistry.js";
import { fixtureApiContract } from "./apiOperationContractFixtures.js";
import { apiCatalogOpenApi } from "./apiOperationCatalog.js";

test("an out-of-tree module registers its own API through the host port and updates discovery atomically without kernel edits", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "api-out-of-tree-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("api-out-of-tree-"));
    return fs.rm(root, { recursive: true, force: true });
  });
  let runtime: GenerationRuntime | undefined;
  const changes: string[] = [];
  const routes = new ManagerPluginRouteRegistry(() => new Set(runtime?.current().records.filter(record => record.status === "active").map(record => record.identity.activationId)), {
    identity: () => ({ applicationGenerationId: "app", managerInstanceId: "manager", pluginGenerationId: runtime?.current().id ?? "initial" }),
    changed: snapshot => { changes.push(snapshot.catalogDigest); }
  });
  const port = createManagerApiOperationsService(routes);
  assert.throws(() => port.registerOperations([]), /active Manager plugin context/);
  runtime = new GenerationRuntime({ host: "manager", hostServices: [{ capability: "host.manager.operations@1", value: port }],
    applicationIdentity: { applicationGenerationId: "app", managerInstanceId: "manager" }, onPublished: () => { routes.refreshPublication(); } });
  t.after(() => runtime!.dispose());
  async function candidate(version: string, pathname: string, valid = true): Promise<PluginCandidate> {
    const entry = path.join(root, `plugin-${version}.mjs`);
    const contract = fixtureApiContract({ pathTemplate: pathname, ...(valid ? {} : { contractVersion: "invalid" }) });
    await fs.writeFile(entry, `export async function activate(context) {
      const api = context.services.require("host.manager.operations@1");
      context.services.provide("example.api@1", Object.freeze({ version: "1" }));
      context.effects.add(() => {
        const registration = api.registerOperations([{contract: ${JSON.stringify(contract)}, handler: () => ({status: 200, body: {ok: true, value: 1}})}]);
        return () => registration.dispose();
      });
    }`);
    return { instanceId: "example:out-of-tree", revision: version, config: {},
      manifest: { schemaVersion: 2, id: "io.example.api-plugin", version: "1.0.0", entries: { manager: { execution: "in_process", module: path.basename(entry) } },
        provides: ["example.api@1"], requires: ["host.manager.operations@1"], optional: [], permissions: [] }, entry: { execution: "in_process", path: entry } };
  }
  await runtime.switch([await candidate("one", "/api/plugin-one/:recordId")]);
  assert.ok(runtime.current().records.every(record => record.status === "active"), JSON.stringify(runtime.current().records.map(record => ({ status: record.status, error: record.error }))));
  const first = routes.catalogSnapshot();
  assert.equal(first.coverage.complete, true); assert.equal(first.operations.length, 1);
  assert.equal(first.operations[0]?.owner.instanceId, "example:out-of-tree");
  assert.ok(((await apiCatalogOpenApi(first)).paths as Record<string, unknown>)["/api/plugin-one/{recordId}"]);
  await runtime.switch([await candidate("two", "/api/plugin-two/:recordId")]);
  const second = routes.catalogSnapshot();
  assert.equal(second.operations[0]?.contract.pathTemplate, "/api/plugin-two/:recordId");
  assert.ok(second.catalogRevision > first.catalogRevision);
  await runtime.switch([await candidate("bad", "/api/plugin-bad/:recordId", false)]);
  const retained = routes.catalogSnapshot();
  assert.equal(retained.operations[0]?.contract.pathTemplate, "/api/plugin-two/:recordId");
  assert.ok(runtime.current().records.some(record => record.error));
  await runtime.switch([]);
  assert.equal(routes.catalogSnapshot().operations.length, 0);
  assert.ok(changes.length >= 3);
});
