import assert from "node:assert/strict";
import test from "node:test";
import { compileApiOperation, type ApiOperationDefinition, type ApiOperationDiscovery } from "../../../../manager/apiOperationContract.js";
import { createApiCatalogSnapshot, type ApiPublishedOperation } from "../../../../manager/apiOperationCatalog.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { fixtureApiContract } from "../../../../manager/apiOperationContractFixtures.js";
import { apiDiscoveryIndex, prepareApiDiscoveryIndex, apiOperationDescription, apiOperationPage } from "./apiDiscoveryIndex.js";

function operation(id: string, pathTemplate: string, discovery?: ApiOperationDiscovery): ApiPublishedOperation {
  const compiled = compileApiOperation({ contract: fixtureApiContract({ operationId: id, pathTemplate }), discovery,
    handler: () => ({ status: 200, body: { ok: true, value: 1 } }) });
  return { contract: compiled.contract, contractDigest: compiled.digest, discovery: compiled.discovery,
    discoveryIssues: compiled.discoveryIssues, owner: { instanceId: "manager:fixture", pluginId: "io.fixture.plugin" } };
}
function snapshot(operations: readonly ApiPublishedOperation[], revision = 1) {
  return createApiCatalogSnapshot({ applicationGenerationId: "app", managerInstanceId: "manager", pluginGenerationId: "plugins" }, revision, operations, []);
}

test("navigation metadata changes catalog identity without changing execution contract digest", () => {
  const first = operation("fixture.messages", "/api/fixture/messages", { title: "First", category: { id: "messages", title: "Messages" } });
  const next = operation("fixture.messages", "/api/fixture/messages", { title: "Next", category: { id: "messages", title: "Messages" } });
  assert.equal(first.contractDigest, next.contractDigest);
  assert.notEqual(snapshot([first]).catalogDigest, snapshot([next]).catalogDigest);
  assert.equal(Object.hasOwn(first.contract, "discovery"), false);
});

test("seven categories and plugin subcategories retain every operation and accurate parent counts", () => {
  const value = snapshot([
    operation("agent.qq.history.read", "/api/agent/qq/history"),
    operation("fixture.home", "/native/home", { title: "Living room", category: { id: "io.fixture.home", title: "Home", parentId: "devices" } }),
    operation("fixture.future", "/future/feature")
  ]);
  const index = apiDiscoveryIndex(value);
  assert.equal(apiDiscoveryIndex(value), index);
  for (const id of ["messages", "agents", "knowledge", "devices", "settings", "automation", "runtime"]) assert.ok(index.categories.some(category => category.id === id));
  assert.equal(index.categories.find(category => category.id === "devices")!.count, 1);
  assert.equal(index.categories.find(category => category.id === "io.fixture.home")!.ownerPluginId, "io.fixture.plugin");
  assert.equal(apiOperationPage(value, {}).total, 3);
  assert.equal(apiOperationPage(value, { category: "devices" }).items[0]!.operationId, "fixture.home");
});

test("invalid per-operation metadata and category cycles leave neighboring operations discoverable", () => {
  const circular: Record<string, unknown> = {}; circular.self = circular;
  const invalid = compileApiOperation({ contract: fixtureApiContract({ operationId: "fixture.invalid" }),
    discovery: circular as ApiOperationDiscovery, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) });
  const broken = { contract: invalid.contract, contractDigest: invalid.digest, discovery: invalid.discovery,
    discoveryIssues: invalid.discoveryIssues, owner: { instanceId: "manager:fixture" } };
  const value = snapshot([operation("fixture.valid", "/api/roles/:roleId/memory"), broken,
    operation("fixture.cycle", "/native/cycle", { category: { id: "io.fixture.cycle", title: "Cycle", parentId: "io.fixture.cycle" } }),
    operation("fixture.badTags", "/native/tags", { tags: 3 } as unknown as ApiOperationDiscovery)]);
  assert.equal(apiOperationPage(value, {}).total, 4);
  assert.ok(apiOperationDescription(value, "fixture.invalid").discovery.issues?.includes("discovery_metadata_invalid"));
  assert.ok(apiOperationDescription(value, "fixture.cycle").discovery.issues?.includes("discovery_category_cycle"));
  assert.ok(apiOperationDescription(value, "fixture.badTags").discovery.issues?.includes("discovery_tags_invalid"));
});

test("Chinese keywords and category, provider, owner, method and path prefix filters share cached summaries", () => {
  const value = snapshot([operation("agent.qq.history.read", "/api/agent/qq/history", {
    title: "读取群聊历史", keywords: ["群消息", "历史记录"], tags: ["QQ"], provider: "napcat" }),
    operation("fixture.read", "/api/fixture/read", { provider: "other" })]);
  const page = apiOperationPage(value, { category: "messages", query: "QQ 群消息", provider: "napcat", owner: "manager:fixture", method: "POST", pathPrefix: "/api/agent/qq" });
  assert.equal(page.total, 1); assert.equal(page.items[0]!.operationId, "agent.qq.history.read");
  assert.equal(apiOperationPage(value, { query: "missing" }).total, 0);
  assert.equal(Object.hasOwn(page.items[0]!, "contract"), false);
  assert.equal(Object.hasOwn(page.items[0]!, "help"), false);
  assert.deepEqual(page.items[0]!.requiredInputs, { path: ["recordId"], query: [], headers: [], body: ["value"] });
});

test("summary cursor binds original filters and snapshot and reports every remaining item", () => {
  const operations = Array.from({ length: 43 }, (_, index) => operation(`fixture.item.${index}`, `/api/items/${index}`));
  const value = snapshot(operations);
  const first = apiOperationPage(value, {}, 20);
  const second = apiOperationPage(value, {}, 20, first.nextCursor);
  const last = apiOperationPage(value, {}, 20, second.nextCursor);
  assert.equal(new Set([...first.items, ...second.items, ...last.items].map(item => item.operationId)).size, 43);
  assert.equal(last.nextCursor, "");
  assert.throws(() => apiOperationPage(value, { method: "POST" }, 20, first.nextCursor), /API_CATALOG_SNAPSHOT_CHANGED/);
  assert.throws(() => apiOperationPage(snapshot(operations, 2), {}, 20, first.nextCursor), /API_CATALOG_SNAPSHOT_CHANGED/);
  assert.throws(() => apiOperationPage(value, {}, 20, "null"), /API_OPERATIONS_CURSOR_INVALID/);
});

test("describe projections preserve parameter-source references, transport binding and one full contract", () => {
  const original = operation("fixture.describe", "/api/describe", { inputSources: [{ field: "query.routeId", operationId: "fixture.routes", resultPath: "/data/items", valuePath: "/id", parameters: { "query.kind": { value: "group" } } }],
    relatedOperations: ["fixture.routes"], automationTemplates: [{ id: "fixture.template", version: "1.0.0", title: "Template", message: "Default trigger message" }] });
  const value = snapshot([original]);
  const full = apiOperationDescription(value, "fixture.describe");
  assert.ok("contract" in full);
  assert.equal(full.contract, original.contract);
  assert.equal(Object.hasOwn(full, "help"), false);
  assert.equal(full.discovery.inputSources![0]!.valuePath, "/id");
  assert.equal(full.discovery.automationTemplates![0]!.message, "Default trigger message");
  assert.equal(Object.hasOwn(apiOperationDescription(value, "fixture.describe", "input"), "responses"), false);
  assert.equal(Object.hasOwn(apiOperationDescription(value, "fixture.describe", "result"), "request"), false);
  assert.equal(Object.hasOwn(apiOperationDescription(value, "fixture.describe", "input").discovery, "automationTemplates"), false);
  assert.equal(Object.hasOwn(apiOperationDescription(value, "fixture.describe", "result").discovery, "automationTemplates"), false);
  assert.throws(() => apiOperationDescription(value, "missing"), /API_OPERATION_NOT_FOUND/);
});

test("large response schemas stay outside lightweight summary pages", () => {
  const definition: ApiOperationDefinition = { contract: fixtureApiContract({ operationId: "fixture.large", description: "A large result schema",
    responses: { "200": { mediaType: "application/json", schema: { type: "object", properties: Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`field${i}`, { type: "string", description: "Large details ".repeat(30) }])) } } } }), handler: () => ({ status: 200, body: {} }) };
  const compiled = compileApiOperation(definition);
  const value = snapshot([{ contract: compiled.contract, contractDigest: compiled.digest, owner: { instanceId: "manager:fixture" } }]);
  assert.ok(Buffer.byteLength(JSON.stringify(apiOperationDescription(value, "fixture.large"))) > 200_000);
  assert.ok(Buffer.byteLength(JSON.stringify(apiOperationPage(value, {}))) < 2_000);
});


test("metadata-only native listener updates refresh the same proxy execution while keeping its exact contract", async () => {
  const registry = new ManagerPluginRouteRegistry();
  const native = registry.registerExternalListener("fixture-native", { listenerId: "fixture.native", address: { protocol: "http", hostname: "127.0.0.1", port: 12345 },
    protocol: "fixture", invocation: "native", authentication: { kind: "none", description: "Native fixture" } });
  const contract = fixtureApiContract({ operationId: "fixture.native.operation" });
  const first = native.registerOperations([{ contract, discovery: { title: "Old native title" }, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  const original = registry.catalogSnapshot();
  const originalOperation = original.operations[0]!;
  await first.dispose();
  const next = native.registerOperations([{ contract, discovery: { title: "New native title", provider: undefined }, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
  const current = registry.catalogSnapshot();
  assert.equal(current.operations[0]!.contractDigest, originalOperation.contractDigest);
  assert.deepEqual(current.operations[0]!.access, originalOperation.access);
  assert.notEqual(current.catalogDigest, original.catalogDigest);
  const detail = apiOperationDescription(current, "fixture.native.operation");
  assert.equal(detail.discovery.title, "New native title"); assert.ok(detail.binding); assert.ok(detail.access);
  assert.equal(detail.access.contractDigest, originalOperation.access!.contractDigest);
  await next.dispose(); await native.dispose(); await registry.disposeNativeListenerHttp();
});


test("a large active catalog reuses one in-memory index and compact default pages", t => {
  const base = operation("fixture.base", "/api/base");
  const operations = Array.from({ length: 1200 }, (_, index) => ({ ...base,
    contract: { ...base.contract, operationId: `fixture.large.${index}`, pathTemplate: `/api/fixture/${index}` } }));
  const value = snapshot(operations);
  const started = performance.now(); const index = apiDiscoveryIndex(value); const preparedMs = performance.now() - started;
  const first = apiOperationPage(value, {});
  for (let read = 0; read < 100; read++) {
    assert.equal(apiDiscoveryIndex(value), index);
    assert.equal(apiOperationPage(value, {}).items[0], first.items[0]);
  }
  const bytes = Buffer.byteLength(JSON.stringify(first));
  assert.equal(first.count, 20); assert.equal(first.total, 1200); assert.ok(bytes < 8192);
  t.diagnostic(JSON.stringify({ operations: 1200, preparedMs, repeatedReads: 100, summaryPageBytes: bytes }));
});


test("cold index preparation yields and cancellation never publishes a partial catalog", async () => {
  const base = operation("fixture.prepare", "/api/prepare");
  const value = snapshot(Array.from({ length: 1200 }, (_, index) => ({ ...base,
    contract: { ...base.contract, operationId: `fixture.prepare.${index}`, pathTemplate: `/api/prepare/${index}` } })));
  const cancellation = new AbortController();
  const aborted = prepareApiDiscoveryIndex(value, cancellation.signal);
  cancellation.abort(); await assert.rejects(aborted, /AbortError|aborted/);
  let yields = 0, active = true;
  const poll = new Promise<void>(resolve => {
    const tick = () => { if (!active) { resolve(); return; } yields++; setImmediate(tick); }; setImmediate(tick);
  });
  const prepared = await prepareApiDiscoveryIndex(value);
  active = false; await poll;
  assert.ok(yields > 3); assert.equal(prepared.operations.length, 1200);
  assert.equal(await prepareApiDiscoveryIndex(value), prepared);
  assert.equal(apiOperationPage(value, {}).total, 1200);
});


test("conflicting category labels and malformed argument-source maps stay local to their operation", () => {
  const value = snapshot([
    operation("fixture.category.0-first", "/first", { category: { id: "io.fixture.shared", title: "Shared", parentId: "messages" } }),
    operation("fixture.category.1-conflict", "/second", { category: { id: "io.fixture.shared", title: "Other", parentId: "devices" } }),
    operation("fixture.sources.bad", "/third", { inputSources: [{ field: "query.id", operationId: "fixture.list", resultPath: "/data/items", parameters: null }] } as unknown as ApiOperationDiscovery)
  ]);
  assert.equal(apiOperationPage(value, {}).total, 3);
  assert.ok(apiOperationDescription(value, "fixture.category.1-conflict").discovery.issues?.includes("discovery_category_conflict"));
  assert.equal(apiDiscoveryIndex(value).categories.find(category => category.id === "io.fixture.shared")!.parentId, "messages");
  const bad = apiOperationDescription(value, "fixture.sources.bad");
  assert.ok(bad.discovery.issues?.includes("discovery_inputSource_invalid"));
  assert.deepEqual(bad.discovery.inputSources, []);
});
