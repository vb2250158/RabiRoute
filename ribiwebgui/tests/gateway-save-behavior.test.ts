import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { cloneGatewayValue, mergeGatewayDraft } from "../src/gatewayDraft";
import { addRouteAgent, removeRouteAgent, selectRouteAgent } from "../src/routeAgentTargetEditor";
import { remoteAgentTargetKey } from "../../src/shared/routeAgentTargets";
import { removePersonaOwnedGatewayConfig } from "../../src/shared/remotePersonaReference";

Object.assign(globalThis, { window: { location: { pathname: "/", hash: "" } } });
const { useGatewayStore } = await import("../src/stores/gatewayStore");

async function fixture(initialRows: any[] = [{ id: "a", configName: "a", enabled: true }, { id: "b", configName: "b", enabled: true }]) {
  setActivePinia(createPinia());
  const store = useGatewayStore();
  let rows: any[] = cloneGatewayValue(initialRows);
  let beforeReply: (() => Promise<void>) | undefined;
  let loseResponse = false;
  let writes = 0;
  let recoveries = 0;
  let recoveryUnavailable = false;
  const deleteIds: string[] = [];
  let catalogReads = 0;
  let catalogResponse: (() => Response) | undefined;
  let beforeCatalogReply: (() => void) | undefined;
  let generation = "test-generation";
  let revision = "a".repeat(64);
  const committed = new Set<string>();
  const payload = () => ({ code: 0, data: { config: { gateways: rows }, manager: [] }, routeCatalog: { routeConfigHash: revision } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/meta")) return Response.json({ applicationGenerationId: generation, managerInstanceId: "test-manager" });
    if (url.endsWith("/network-options")) return Response.json({ code: 0, data: {} });
    if (url.includes("/mutations/")) {
      recoveries++;
      if (recoveryUnavailable) throw new TypeError("recovery unavailable");
      const operationId = decodeURIComponent(url.split("/mutations/")[1]);
      return Response.json({ ...payload(), receipt: { operationId, state: committed.has(operationId) ? "committed" : "not_committed" } });
    }
    if (init?.method === "PUT") {
      writes++;
      const sent = JSON.parse(String(init.body));
      const id = decodeURIComponent(url.split("/gateways/")[1].split("/")[0]);
      rows = rows.some(row => row.id === id) ? rows.map(row => row.id === id ? sent : row) : [...rows, sent];
      const operationId = (init.headers as Record<string, string>)["idempotency-key"];
      committed.add(operationId);
      if (beforeReply) await beforeReply();
      if (loseResponse) throw new TypeError("connection lost after commit");
      return Response.json({ ...payload(), receipt: { operationId, state: "committed", routeConfigHash: revision } });
    }
    if (init?.method === "POST" && url.endsWith("/delete")) {
      const id = decodeURIComponent(url.split("/gateways/")[1].split("/")[0]);
      deleteIds.push(id);
      assert.equal((init.headers as Record<string, string>)["if-match"], `"${revision}"`);
      const operationId = (init.headers as Record<string, string>)["idempotency-key"];
      committed.add(operationId);
      rows = rows.filter(row => row.id !== id);
      return Response.json({ ...payload(), receipt: { operationId, state: "committed", routeConfigHash: revision } });
    }
    assert.equal(init?.method, undefined, "Saving must not replace the catalog");
    catalogReads++;
    if (beforeCatalogReply) beforeCatalogReply();
    if (catalogResponse) return catalogResponse();
    return Response.json(payload());
  }) as typeof fetch;
  await store.load();
  rows = cloneGatewayValue(store.gateways);
  return {
    store, get rows() { return rows; }, get writes() { return writes; }, get recoveries() { return recoveries; },
    deleteIds, get catalogReads() { return catalogReads; },
    delay(action: () => Promise<void>) { beforeReply = action; },
    loseResponse() { loseResponse = true; },
    recoveryUnavailable(value: boolean) { recoveryUnavailable = value; },
    catalogResponse(reply: (() => Response) | undefined) { catalogResponse = reply; },
    beforeCatalogReply(action: () => void) { beforeCatalogReply = action; },
    changeGeneration() { generation = "next-generation"; },
    changeRevision() { revision = "b".repeat(64); }
  };
}

test("instance target selection survives actual store PUT and reload without overwriting local Codex", async () => {
  const f = await fixture();
  const draft = f.store.gateways[0];
  addRouteAgent(draft, "codex");
  draft.codexThreadId = "local-codex";
  draft.codexCwd = "C:/LocalProject";
  const binding = { instanceId: "remote-computer", agentId: "remote-codex" };
  addRouteAgent(draft, "codex", binding.instanceId, binding.agentId);
  selectRouteAgent(draft, remoteAgentTargetKey(binding));
  await f.store.save();
  assert.equal(f.writes, 1);
  assert.equal(f.rows[0].primaryAgentTarget, remoteAgentTargetKey(binding));
  assert.equal(f.rows[0].agentInstanceBindings, undefined);
  await f.store.load();
  assert.equal(f.store.gateways[0].primaryAgentTarget, remoteAgentTargetKey(binding));
  assert.equal(f.store.gateways[0].codexThreadId, "local-codex");
  assert.equal(f.store.gateways[0].codexCwd, "C:/LocalProject");
  assert.deepEqual(f.store.gateways[0].agentAdapters, ["codex"]);
  removeRouteAgent(f.store.gateways[0], remoteAgentTargetKey(binding));
  await f.store.save();
  await f.store.load();
  assert.equal(f.store.gateways[0].primaryAgentTarget, "");
  assert.equal(f.store.gateways[0].primaryAgentAdapter, undefined);
  assert.equal(f.store.gateways[0].codexThreadId, "local-codex");
});

test("remote persona references survive route save and reload without copying persona projections or changing local agents", async () => {
  const f = await fixture();
  addRouteAgent(f.store.gateways[0], "codex");
  selectRouteAgent(f.store.gateways[0], "local:codex");
  Object.assign(f.store.gateways[0], {
    agentRoleId: "same-role", agentRoleDeviceId: "peer-a", agentRoleFile: "persona.md",
    codexThreadId: "local-thread", codexCwd: "C:/LocalProject", routeVariables: { project: "local" },
    automationRules: [], languageStyle: { styleSkillUrl: "old-local-style" }, recentMessageLimits: { napcat: 5 }
  });
  f.store.gateways[0] = removePersonaOwnedGatewayConfig(f.store.gateways[0]);
  await f.store.save("a");
  await f.store.load();
  const saved = f.store.gateways[0];
  assert.equal(saved.agentRoleDeviceId, "peer-a");
  assert.equal(saved.agentRoleId, "same-role");
  assert.equal(saved.agentRoleFile, "persona.md");
  assert.equal(saved.codexThreadId, "local-thread");
  assert.equal(saved.codexCwd, "C:/LocalProject");
  assert.equal(saved.primaryAgentTarget, "local:codex");
  assert.deepEqual(saved.routeVariables, { project: "local" });
  assert.equal(saved.automationRules, undefined);
  assert.equal(saved.notificationRules, undefined);
  assert.equal(saved.languageStyle, undefined);
  assert.equal(saved.recentMessageLimits, undefined);
});

test("delivery tests serialize a concrete target instead of routing by provider", async () => {
  const f = await fixture();
  const calls: any[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return Response.json({ code: 0, data: { ...body, status: "delivered", deliveryId: "test", gatewayId: "a", completedAt: new Date().toISOString() } });
  }) as typeof fetch;
  await f.store.testAgentDelivery("a", "codex");
  const id = remoteAgentTargetKey({ instanceId: "remote", agentId: "codex" });
  const result = await f.store.testAgentDelivery("a", "codex", id);
  assert.deepEqual(calls, [{ agentAdapterType: "codex", agentTargetId: "local:codex" }, { agentAdapterType: "codex", agentTargetId: id }]);
  assert.equal(result.agentTargetId, id);
});

test("saving a captured route ID does not save the newly selected route", async () => {
  const f = await fixture();
  f.store.gateways[0].name = "captured route change";
  f.store.gateways[1].name = "unrelated draft";
  f.store.selectedGatewayId = "b";
  await f.store.save("a");
  assert.equal(f.rows[0].name, "captured route change");
  assert.notEqual(f.rows[1].name, "unrelated draft");
  assert.equal(f.store.selectedGatewayId, "b");
});

test("saving one route preserves another route's local draft and remote update", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.store.gateways[1].name = "local draft";
  f.rows[1].heartbeatMessage = "remote update";
  await f.store.save();
  assert.equal(f.rows[0].enabled, false);
  assert.equal(f.rows[1].heartbeatMessage, "remote update");
  assert.notEqual(f.rows[1].name, "local draft");
  assert.equal(f.store.gateways[1].name, "local draft");
  assert.equal(f.store.dirty, true);
});

test("reverting an edit clears dirty without saving", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.store.touch();
  assert.equal(f.store.dirty, true);
  f.store.gateways[0].enabled = true;
  f.store.touch();
  assert.equal(f.store.dirty, false);
});

test("overview saves changed routes individually without changing the selected route", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.store.gateways[1].enabled = false;
  await f.store.saveChangedRoutes();
  assert.equal(f.writes, 2);
  assert.equal(f.store.selectedGatewayId, "a");
  assert.equal(f.store.dirty, false);
});

test("a late acknowledgement preserves newer edits and concurrent clicks share one write", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  f.delay(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  f.store.gateways[0].enabled = false;
  const first = f.store.save();
  const second = f.store.save();
  await reached;
  f.store.gateways[0].name = "edited while saving";
  release();
  await Promise.all([first, second]);
  assert.equal(f.writes, 1);
  assert.equal(f.store.gateways[0].name, "edited while saving");
  assert.equal(f.store.dirty, true);
});

test("a lost committed response is recovered without resubmitting the write", async () => {
  const f = await fixture();
  f.store.gateways[0].enabled = false;
  f.loseResponse();
  await f.store.save();
  assert.equal(f.writes, 1);
  assert.equal(f.recoveries, 1);
  assert.equal(f.store.saveState, "saved");
  assert.equal(f.store.dirty, false);
});

test("independent fields merge and overlapping edits fail before writing", async () => {
  assert.deepEqual(mergeGatewayDraft({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 }), { a: 2, b: 2 });
  const f = await fixture();
  f.store.gateways[0].name = "local";
  f.rows[0].name = "remote";
  await assert.rejects(f.store.save(), /配置冲突/);
  assert.equal(f.writes, 0);
  assert.equal(f.store.gateways[0].name, "local");
  assert.equal(f.store.saveState, "conflict");
});

test("editing after an unresolved response recovers the earlier baseline before saving the new draft", async () => {
  const f = await fixture();
  f.loseResponse();
  f.recoveryUnavailable(true);
  f.store.gateways[0].name = "first save";
  await assert.rejects(f.store.save(), /recovery unavailable/);
  assert.equal(f.store.saveState, "confirming");
  f.store.gateways[0].name = "newer draft";
  f.recoveryUnavailable(false);
  await f.store.save();
  assert.equal(f.writes, 2);
  assert.equal(f.rows[0].name, "newer draft");
  assert.equal(f.store.dirty, false);
});

test("cancelling an unsaved new route confirms absence and clears the empty-page draft without a delete write", async () => {
  const f = await fixture([]);
  f.store.addGatewayAndOpenQuickSetup();
  const id = f.store.selectedGatewayId;
  const reads = f.catalogReads;
  assert.equal(f.store.dirty, true);
  assert.equal(f.store.quickSetupDialogOpen, true);
  await f.store.deleteGateway(id);
  assert.equal(f.catalogReads, reads + 1, "Cancellation must read the latest includeConfig catalog");
  assert.deepEqual(f.deleteIds, []);
  assert.equal(f.writes, 0);
  assert.deepEqual(f.store.gateways, []);
  assert.equal(f.store.selectedGatewayId, "");
  assert.equal(f.store.quickSetupDialogOpen, false);
  assert.equal(f.store.dirty, false, "No discarded draft should keep beforeunload active");
});

test("cancelling a new route preserves edits on another route", async () => {
  const f = await fixture();
  f.store.gateways[0].name = "another unsaved edit";
  f.store.addGateway();
  await f.store.deleteGateway(f.store.selectedGatewayId);
  assert.equal(f.store.selectedGatewayId, "a");
  assert.equal(f.store.gateways[0].name, "another unsaved edit");
  assert.equal(f.store.gateways.length, 2);
  assert.equal(f.store.dirty, true);
  assert.deepEqual(f.deleteIds, []);
});

test("a server route matching an unsaved draft ID or configuration name is preserved as a conflict", async () => {
  for (const serverIdentity of [
    { id: "config-1", configName: "another-config" },
    { id: "another-route", configName: "config-1" },
    { id: "config-1", configName: "config-1" }
  ]) {
    const f = await fixture([]);
    f.store.addGateway();
    const localId = f.store.selectedGatewayId;
    const draft = cloneGatewayValue(f.store.gateways[0]);
    f.rows.push({ ...draft, ...serverIdentity, name: "created by another page" });
    const serverRows = cloneGatewayValue(f.rows);
    f.changeRevision();
    await assert.rejects(f.store.deleteGateway(localId), /配置冲突.*相同 ID 或配置名.*草稿已保留/);
    assert.deepEqual(f.deleteIds, [], "A catalog match does not prove this page saved the server route");
    assert.deepEqual(f.rows, serverRows);
    assert.deepEqual(f.store.gateways, [draft]);
    assert.equal(f.store.dirty, true);
    assert.equal(f.store.saving, false);
  }
});

test("a saved route keeps using managed deletion", async () => {
  const f = await fixture();
  await f.store.deleteGateway("a");
  assert.deepEqual(f.deleteIds, ["a"]);
  assert.deepEqual(f.store.gateways.map(row => row.id), ["b"]);
  assert.equal(f.store.dirty, false);
});

test("an unavailable or incomplete catalog cannot prove a new route is only a draft", async () => {
  const responses = [
    () => Response.json({ code: 1 }, { status: 503 }),
    () => Response.json({ code: 0, data: { config: {} } }),
    () => Response.json({ code: 0, data: { config: { gateways: [{ name: "missing identity" }] } } }),
    () => new Response("<!doctype html><html>old page</html>")
  ];
  for (const reply of responses) {
    const f = await fixture([]);
    f.store.addGateway();
    const draft = cloneGatewayValue(f.store.gateways[0]);
    f.catalogResponse(reply);
    await assert.rejects(f.store.deleteGateway(draft.id), /无法确认服务端.*草稿已保留/);
    assert.deepEqual(f.store.gateways, [draft]);
    assert.deepEqual(f.deleteIds, []);
    assert.equal(f.store.dirty, true);
    assert.equal(f.store.saving, false);
  }
});

test("a Manager identity change while checking absence retains the new route", async () => {
  const f = await fixture([]);
  f.store.addGateway();
  const draft = cloneGatewayValue(f.store.gateways[0]);
  f.beforeCatalogReply(() => f.changeGeneration());
  await assert.rejects(f.store.deleteGateway(draft.id), /Manager 已重启.*草稿已保留/);
  assert.deepEqual(f.store.gateways, [draft]);
  assert.deepEqual(f.deleteIds, []);
  assert.equal(f.store.dirty, true);
});

test("changing a draft configuration name while checking the catalog preserves the draft", async () => {
  const f = await fixture([]);
  f.store.addGateway();
  const id = f.store.selectedGatewayId;
  f.beforeCatalogReply(() => { f.store.renameGatewayConfig(id, "changed-during-check"); });
  await assert.rejects(f.store.deleteGateway(id), /配置名已变化.*草稿已保留/);
  assert.equal(f.store.gateways[0].configName, "changed-during-check");
  assert.deepEqual(f.deleteIds, []);
  assert.equal(f.store.dirty, true);
});

test("a committed but unconfirmed new route is retained until receipt recovery, then deleted through the Manager", async () => {
  const f = await fixture([]);
  f.store.addGateway();
  const id = f.store.selectedGatewayId;
  f.delay(async () => { f.rows[0].id = "persisted-route"; });
  f.loseResponse();
  f.recoveryUnavailable(true);
  await assert.rejects(f.store.save(id), /recovery unavailable/);
  assert.equal(f.rows.length, 1, "The save committed despite its lost response");
  const reads = f.catalogReads;
  await assert.rejects(f.store.deleteGateway(id), /recovery unavailable/);
  assert.equal(f.catalogReads, reads, "An unresolved receipt must be recovered before checking draft absence");
  assert.equal(f.store.gateways.length, 1);
  assert.deepEqual(f.deleteIds, []);
  assert.equal(f.store.saveState, "confirming");
  f.recoveryUnavailable(false);
  await f.store.deleteGateway(id);
  assert.deepEqual(f.deleteIds, ["persisted-route"], "Recovery must resolve the persisted ID before managed deletion");
  assert.deepEqual(f.rows, []);
  assert.deepEqual(f.store.gateways, []);
  assert.equal(f.store.dirty, false);
});
