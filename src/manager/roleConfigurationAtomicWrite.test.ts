import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { atomicRoleJson } from "../roleLifecycle.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createRoleConfigurationOperations } from "./roleConfigurationOperations.js";

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "role-atomic-fence-test-"));
  const rolesRoot = path.join(directory, "roles"), role = path.join(rolesRoot, "Example"), file = path.join(role, "personaConfig.json");
  await fs.mkdir(role, { recursive: true });
  await fs.writeFile(path.join(role, "persona.md"), "# Example\n");
  const originalBytes = JSON.stringify({ extension: { retained: true }, speechTriggerKeywords: ["original"] });
  await fs.writeFile(file, originalBytes);
  let enabled = true, connectionGeneration = 1, currentRoot = rolesRoot, readOnly = false, events = 0;
  const identity = { applicationGenerationId: "original-generation", managerInstanceId: "original-manager" };
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("role-atomic-fence-test", createRoleConfigurationOperations({
    rolesRoot: () => currentRoot, identity: () => identity, routes: () => [], isReadOnly: () => readOnly,
    assertCatalogReady() {}, changed: async (_roleId, assertCurrent) => { assertCurrent(); events++; }
  }));
  const server = http.createServer((request, response) => {
    Object.defineProperty(request.socket, "remoteAddress", { value: "192.0.2.25", configurable: true });
    const originalConnection = connectionGeneration;
    markAuthenticatedConnectionRequest(request, () => {
      if (!enabled || originalConnection !== connectionGeneration) throw new Error("Original connection revoked");
    });
    assert.equal(assertTrustedLanAgentPrincipal(request), undefined);
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("role-atomic-fence-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const call = async (method = "GET", body?: unknown, key: string = randomUUID()) => {
    const response = await fetch(base + "/api/roles/Example/configuration", { method,
      headers: { "content-type": "application/json", "idempotency-key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { role, file, originalBytes, call, events: () => events,
    change(boundary: "connection" | "root" | "generation" | "read-only") {
      if (boundary === "connection") { enabled = false; connectionGeneration++; }
      if (boundary === "root") currentRoot = path.join(directory, "replacement");
      if (boundary === "generation") identity.applicationGenerationId = "replacement-generation";
      if (boundary === "read-only") readOnly = true;
    },
    reconnect() { enabled = true; connectionGeneration++; currentRoot = rolesRoot; readOnly = false; }
  };
}

for (const boundary of ["connection", "root", "generation", "read-only"] as const) {
  test(`HTTP ${boundary} change after temporary configuration write prevents rename, cleans temporary bytes and preserves original data`, async t => {
    const f = await fixture(t), original = await f.call(), key = randomUUID();
    assert.equal(original.status, 200);
    const payload = { expectedRevision: original.body.data.revision, config: { speechTriggerKeywords: ["replacement"] } };
    const records: RecordedDataMutationAudit[] = [], release = installDataMutationAuditSink(record => records.push(record));
    const originalWrite = fs.writeFile, originalRename = fs.rename;
    let intercepted = 0, configurationRenames = 0;
    const write = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await originalWrite(...args);
      if (String(args[0]).startsWith(f.file + ".")) { intercepted++; f.change(boundary); }
      return result;
    });
    const rename = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) === f.file) configurationRenames++;
      return originalRename(...args);
    });
    try {
      const rejected = await f.call("PUT", payload, key);
      assert.equal(intercepted, 1);
      assert.equal(rejected.status, boundary === "connection" || boundary === "read-only" ? 403 : 409);
      assert.equal(rejected.body.uncertain, true);
      assert.equal(rejected.body.data, undefined);
      assert.equal(configurationRenames, 0);
      assert.equal(await fs.readFile(f.file, "utf8"), f.originalBytes);
      assert.deepEqual((await fs.readdir(f.role)).filter(name => name.startsWith("personaConfig.json.") && name.endsWith(".tmp")), []);
      assert.equal(f.events(), 0);
      assert.equal(records.some(record => record.event === "role_file_committed" && record.target.id === "personaConfig.json"), false);
      assert.deepEqual(await fs.readdir(path.join(path.dirname(f.role), ".role-state/locks")), []);
      write.mock.restore(); rename.mock.restore(); f.reconnect();
      const recovered = await f.call("PUT", payload, key);
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.deepEqual(recovered.body.data.config.speechTriggerKeywords, ["replacement"]);
      assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")).extension, { retained: true });
    } finally { write.mock.restore(); rename.mock.restore(); release(); }
  });
}

test("native atomic role writes without an assertion retain their original commit behavior", async t => {
  const f = await fixture(t);
  await atomicRoleJson(f.file, { unchangedNativeContract: true });
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), { unchangedNativeContract: true });
  assert.deepEqual((await fs.readdir(f.role)).filter(name => name.endsWith(".tmp")), []);
});

test("revocation after an accepted rename retains committed data and audit, reports uncertainty and reconciles the original receipt", async t => {
  const f = await fixture(t), original = await f.call(), key = randomUUID();
  const payload = { expectedRevision: original.body.data.revision, config: { speechTriggerKeywords: ["accepted-before-revocation"] } };
  const records: RecordedDataMutationAudit[] = [], release = installDataMutationAuditSink(record => records.push(record));
  const originalRename = fs.rename;
  let configurationRenames = 0;
  const rename = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const result = await originalRename(...args);
    if (String(args[1]) === f.file) { configurationRenames++; f.change("connection"); }
    return result;
  });
  try {
    const rejected = await f.call("PUT", payload, key);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.body.uncertain, true);
    assert.equal(rejected.body.data, undefined);
    assert.equal(configurationRenames, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")).speechTriggerKeywords, ["accepted-before-revocation"]);
    assert.ok(records.some(record => record.event === "role_file_committed" && record.target.id === "personaConfig.json"));
    assert.deepEqual((await fs.readdir(f.role)).filter(name => name.endsWith(".tmp")), []);
    f.reconnect();
    const recovered = await f.call("PUT", payload, key);
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body.data.config.speechTriggerKeywords, ["accepted-before-revocation"]);
    assert.equal(configurationRenames, 1);
  } finally { rename.mock.restore(); release(); }
});
