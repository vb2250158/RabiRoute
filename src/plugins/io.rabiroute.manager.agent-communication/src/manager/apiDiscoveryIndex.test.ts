import assert from "node:assert/strict";
import test from "node:test";
import { compileApiContract, compileApiOperation, type ApiOperationDefinition, type ApiOperationDiscovery } from "../../../../manager/apiOperationContract.js";
import { createApiCatalogSnapshot, type ApiPublishedOperation } from "../../../../manager/apiOperationCatalog.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { fixtureApiContract } from "../../../../manager/apiOperationContractFixtures.js";
import { createPeerControlOperations } from "../../../../peerTunnel/apiControlOperations.js";
import { createPeerProxyHttpOperations } from "../../../../peerTunnel/apiProxyHttpOperations.js";
import { createLanAgentManagementOperations } from "../../../io.rabiroute.manager.core/src/manager/lanAgentRoutes.js";
import { LAN_AGENT_INTERACTIVE_ROUTES, interactiveApiContract } from "../../../io.rabiroute.manager.core/src/manager/lanAgentInteractiveContract.js";
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


test("device search uses operation relevance without inheriting category words", () => {
  const value = snapshot([
    operation("manager.desktop-pet.binding.read", "/api/desktop-pet/roles/:roleId/binding", { title: "读取桌宠绑定" }),
    operation("manager.lan-agent.instances.list", "/api/lan-agent/instances", { title: "查询已接入电脑", keywords: ["电脑", "设备", "computer"], category: { id: "devices", title: "电脑与设备" } }),
    operation("manager.lan-agent.nodes.list", "/api/lan-agent/nodes", { title: "查询设备节点", keywords: ["电脑", "device"], category: { id: "devices", title: "电脑与设备" } }),
    operation("manager.lan-agent.terminals.list", "/api/lan-agent/terminals", { title: "列出终端", keywords: ["terminal"] })
  ]);
  const computers = apiOperationPage(value, { category: "devices", query: "电脑" }, 1);
  assert.equal(computers.total, 2);
  assert.equal(computers.items[0]!.operationId, "manager.lan-agent.instances.list");
  const next = apiOperationPage(value, { category: "devices", query: "电脑" }, 1, computers.nextCursor);
  assert.equal(next.items[0]!.operationId, "manager.lan-agent.nodes.list");
  assert.equal(next.nextCursor, "");
  assert.equal(apiOperationPage(value, { query: "设备" }).items[0]!.operationId, "manager.lan-agent.nodes.list");
  assert.deepEqual(apiOperationPage(value, { query: "terminal" }).items.map(item => item.operationId), ["manager.lan-agent.terminals.list"]);
  assert.equal(apiOperationPage(value, { category: "devices" }).total, 4);
});

test("explicit keywords outrank incidental summaries and category labels do not create matches", () => {
  const value = snapshot([
    operation("fixture.a.incidental", "/api/fixture/a", { title: "节点状态", summary: "可从电脑终端查看", category: { id: "io.fixture.computers", title: "电脑终端", parentId: "devices" } }),
    operation("fixture.z.explicit", "/api/fixture/z", { title: "原生节点", keywords: ["电脑"], category: { id: "io.fixture.computers", title: "电脑终端", parentId: "devices" } }),
    operation("fixture.unrelated", "/api/fixture/other", { title: "灯光亮度", category: { id: "io.fixture.computers", title: "电脑终端", parentId: "devices" } }),
    operation("agent.qq.history.read", "/api/agent/qq/history", { title: "读取QQ群聊记录", keywords: ["群消息", "聊天历史"] }),
    operation("agent.qq.contacts.read", "/api/agent/qq/contacts", { title: "读取QQ联系人" })
  ]);
  assert.deepEqual(apiOperationPage(value, { category: "devices", query: "电脑" }).items.map(item => item.operationId), ["fixture.z.explicit", "fixture.a.incidental"]);
  assert.equal(apiOperationPage(value, { category: "io.fixture.computers" }).total, 3);
  assert.equal(apiOperationPage(value, { query: "io.fixture.computers" }).total, 0);
  assert.deepEqual(apiOperationPage(value, { query: "QQ 群消息" }).items.map(item => item.operationId), ["agent.qq.history.read"]);
  assert.equal(apiOperationPage(value, { query: "不存在的功能" }).total, 0);
});


test("an exact operation identity ranks ahead of another operation mentioning it", () => {
  const value = snapshot([
    operation("fixture.a.reference", "/api/fixture/reference", { title: "fixture.z.target", keywords: ["fixture.z.target"] }),
    operation("fixture.z.target", "/api/fixture/target", { title: "查询目标记录" })
  ]);
  assert.equal(apiOperationPage(value, { query: "fixture.z.target" }).items[0]!.operationId, "fixture.z.target");
});


function nativeComputerOperations(): ApiPublishedOperation[] {
  // These factories only describe operations; none of their captured runtime owners is called.
  const definitions = [
    ...createPeerControlOperations({} as Parameters<typeof createPeerControlOperations>[0]),
    ...createPeerProxyHttpOperations({} as Parameters<typeof createPeerProxyHttpOperations>[0]),
    ...createLanAgentManagementOperations({} as Parameters<typeof createLanAgentManagementOperations>[0]),
    ...LAN_AGENT_INTERACTIVE_ROUTES.map(route => ({ contract: interactiveApiContract(route) }))
  ];
  const ids = new Set(["manager.rabilink.peer.servers.read", "manager.rabilink.peer.http.get", "manager.lan-agent.instances.list", "manager.lan-agent.nodes.list", "manager.lan-agent.terminals.list"]);
  return definitions.filter(definition => ids.has(definition.contract.operationId)).map(definition => {
    const compiled = compileApiContract(definition);
    assert.equal(compiled.discovery, undefined);
    return { contract: compiled.contract, contractDigest: compiled.digest, owner: { instanceId: "manager:native" } };
  });
}

test("native computer factories gain precise shared navigation without registering or changing operations", () => {
  const native = nativeComputerOperations();
  const value = snapshot([...native, operation("manager.desktop-pet.binding.read", "/api/desktop-pet/roles/:roleId/binding", { title: "桌宠绑定" })]);
  assert.equal(native.length, 5);
  for (const query of ["电脑列表", "电脑连接", "远程电脑", "电脑", "computer list", "remote computers"]) {
    const page = apiOperationPage(value, { query, category: "devices" });
    assert.equal(page.items[0]?.operationId, "manager.rabilink.peer.servers.read", query);
    assert.ok(page.items.every(item => !item.operationId.includes("desktop-pet")), query);
  }
  assert.deepEqual(apiOperationPage(value, { query: "terminal" }).items.map(item => item.operationId), ["manager.lan-agent.terminals.list"]);
  const peers = apiOperationDescription(value, "manager.rabilink.peer.servers.read");
  assert.deepEqual(peers.discovery.relatedOperations, ["manager.rabilink.peer.http.get", "manager.lan-agent.instances.list", "manager.lan-agent.nodes.list"]);
  const proxy = apiOperationDescription(value, "manager.rabilink.peer.http.get");
  assert.deepEqual(proxy.discovery.inputSources, [{ field: "path.deviceId", operationId: "manager.rabilink.peer.servers.read", resultPath: "/peers", valuePath: "/deviceId" }]);
  const terminal = apiOperationDescription(value, "manager.lan-agent.terminals.list");
  assert.deepEqual(terminal.discovery.inputSources, [{ field: "path.instanceId", operationId: "manager.lan-agent.instances.list", resultPath: "/instances", valuePath: "/instanceId" }]);
  assert.ok(terminal.discovery.summary!.includes("sessions"));
  assert.ok(terminal.discovery.summary!.includes("shells"));
  for (const row of native) {
    const description = apiOperationDescription(value, row.contract.operationId);
    assert.ok("contract" in description, "the full description retains the original executable contract");
    assert.equal(description.contract, row.contract);
    assert.equal(description.contractDigest, row.contractDigest);
    assert.equal(description.owner, row.owner);
  }
  assert.equal(apiOperationPage(snapshot([]), {}).total, 0);
  assert.throws(() => apiOperationDescription(snapshot([]), "manager.rabilink.peer.servers.read"), /API_OPERATION_NOT_FOUND/);
});

test("native navigation defaults yield to explicit plugin discovery and never fill unknown IDs", () => {
  const original = nativeComputerOperations().find(row => row.contract.operationId === "manager.rabilink.peer.servers.read")!;
  const explicit: ApiPublishedOperation = { ...original, discovery: { title: "自定义主机目录", category: { id: "io.fixture.custom", title: "自定义" }, keywords: ["自定义关键词"], inputSources: [], relatedOperations: [] } };
  const value = snapshot([explicit, operation("fixture.unknown", "/api/fixture/unknown")]);
  const detail = apiOperationDescription(value, explicit.contract.operationId);
  assert.equal(detail.discovery.title, "自定义主机目录");
  assert.equal(detail.discovery.category!.id, "io.fixture.custom");
  assert.deepEqual(detail.discovery.inputSources, []);
  assert.deepEqual(detail.discovery.relatedOperations, []);
  assert.deepEqual(detail.discovery.keywords, ["自定义关键词"]);
  assert.equal(apiOperationPage(value, { query: "电脑连接" }).total, 0);
  assert.equal(apiOperationPage(value, { query: "自定义关键词" }).items[0]!.operationId, explicit.contract.operationId);
  assert.equal(apiOperationDescription(value, "fixture.unknown").discovery.title, "fixture.unknown");
  assert.equal(apiOperationPage(value, {}).total, 2);
});


test("Chinese query synonyms find English-only operation terms without category pollution", () => {
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["记忆", ["memory", "memories"]], ["计划", ["plan", "plans"]], ["技能", ["skill", "skills"]],
    ["文件", ["file", "files", "filesystem"]], ["终端", ["terminal", "terminals", "shell"]],
    ["屏幕", ["screen", "screenshot"]], ["窗口", ["window"]], ["插件", ["plugin", "plugins"]],
    ["角色", ["role", "persona"]], ["配置", ["config", "settings"]], ["设置", ["config", "settings"]],
    ["消息", ["message", "chat"]], ["语音", ["speech", "voice"]], ["视频", ["video"]],
    ["电脑", ["computer", "computers"]], ["设备", ["device", "devices"]]
  ];
  const words = [...new Set(cases.flatMap(([, aliases]) => aliases))];
  const value = snapshot([
    ...words.map(word => operation(`fixture.${word}.read`, `/api/${word}`)),
    operation("manager.desktop-pet.binding.read", "/api/desktop-pet/roles/:roleId/binding"),
    operation("fixture.windows.read", "/api/windows", { title: "Windows runtime status" })
  ]);
  for (const [query, aliases] of cases) {
    const actual = apiOperationPage(value, { query }).items.map(item => item.operationId).sort();
    assert.deepEqual(actual, aliases.map(word => `fixture.${word}.read`).sort(), query);
  }
  const mixed = snapshot([operation("fixture.file.read", "/api/files"), operation("fixture.file.history.read", "/api/files/history"),
    operation("fixture.memory.history.read", "/api/memory/history"), operation("fixture.literal", "/api/fixture/literal", { title: "文件" })]);
  assert.equal(apiOperationPage(mixed, { query: "文件" }).items[0]!.operationId, "fixture.literal");
  assert.deepEqual(apiOperationPage(mixed, { query: "文件 history" }).items.map(item => item.operationId), ["fixture.file.history.read"]);
  assert.equal(apiOperationPage(value, { query: "unknown-query" }).total, 0);
});
