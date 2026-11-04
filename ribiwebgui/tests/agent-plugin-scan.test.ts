import assert from "node:assert/strict";
import test from "node:test";
import { createRouteAgentScanController } from "../src/agentAdapters/routeAgentScanController";
import type { AgentAdapterCatalogEntry } from "../src/agentAdapters/agentAdapterCatalog";
import type { AgentAdapterType, GatewayDefinition } from "../src/types";

function entry(type: AgentAdapterType): AgentAdapterCatalogEntry {
  return { type, title: type, note: "Owned Agent", icon: "mdi-robot", order: 1, location: "local", hasCwd: true, hasThread: true, available: true,
    manifest: { type, label: type, maturity: "experimental", transport: { protocol: "owner", mode: "native" }, capabilities: {} },
    renderer: { key: `owner:${type}`, id: type, instanceId: `agent:${type}`, pluginId: `io.test.${type}`, rendererId: type, placementId: "route.adapters.agent-settings", slot: type, order: 1,
      component: { render: () => null }, agentScanQuery: (route, options) => new URLSearchParams({ selected: route.id, offset: String(options.offset ?? 0) }) } };
}
const result = (type: string, ids: string[]) => Response.json({ agents: { [type]: { type, label: type, maturity: "experimental", installed: true,
  sessions: ids.map(id => ({ id, name: id, projectPath: `/${id}` })) } }, cwdOptions: ["/work"] });
async function settle() { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test("settings entry scans once, explicit refresh is per Agent and failed providers preserve previous results", async () => {
  const calls: string[] = [];
  let broken = false;
  const model = createRouteAgentScanController({ route: () => ({ id: "original" } as GatewayDefinition), catalog: () => [entry("codex"), entry("dsh")],
    fetcher: async input => { const url = String(input); calls.push(url); return url.includes("/dsh?") && broken ? Response.json({ message: "owner offline" }, { status: 503 }) : result(url.includes("/dsh?") ? "dsh" : "codex", ["native-id"]); } });
  model.enter(); model.enter(); await settle();
  assert.equal(calls.length, 2);
  const oldDsh = JSON.parse(JSON.stringify(model.state.value.agents.dsh));
  broken = true;
  await model.scan("dsh", { append: true, offset: 200 });
  assert.equal(calls.length, 3);
  assert.equal(calls[2], "/api/agent-adapters/scan/dsh?selected=original&offset=200");
  assert.equal(calls.filter(url => url.includes("/codex?")).length, 1);
  assert.deepEqual(model.state.value.agents.dsh, oldDsh);
  assert.equal(model.state.value.agents.codex?.installed, true);
  assert.match(model.errors.value.dsh, /owner offline/);
  model.enter(); await settle(); assert.equal(calls.length, 3);
});

test("late scan replies cannot write another Route or replaced owner, and unavailable providers cause no request", async () => {
  let route = { id: "first" } as GatewayDefinition, catalog = [entry("codex")], calls = 0;
  let reply!: (response: Response) => void;
  const model = createRouteAgentScanController({ route: () => route, catalog: () => catalog,
    fetcher: () => { calls++; return new Promise(resolve => { reply = resolve; }); } });
  const pending = model.scan("codex"); route = { id: "second" } as GatewayDefinition;
  reply(result("codex", ["original-task"])); await pending;
  assert.deepEqual(model.state.value.agents, {});
  const second = model.scan("codex"); catalog = [{ ...entry("codex"), renderer: { ...entry("codex").renderer, key: "replacement" } }];
  reply(result("codex", ["wrong-owner"])); await second;
  assert.deepEqual(model.state.value.agents, {});
  catalog = []; await model.scan("codex"); assert.equal(calls, 2);
});

test("pagination merges only this Agent by stable IDs while other Agent results stay intact", async () => {
  let page = 0;
  const model = createRouteAgentScanController({ route: () => ({ id: "route" } as GatewayDefinition), catalog: () => [entry("codex"), entry("dsh")],
    fetcher: async input => String(input).includes("/dsh?") ? result("dsh", ["dsh-kept"]) : result("codex", page++ ? ["one", "two"] : ["one"]) });
  await model.scanAll(); await model.scan("codex", { append: true, offset: 200 });
  assert.deepEqual(model.state.value.agents.codex?.sessions?.map(session => session.id), ["one", "two"]);
  assert.deepEqual(model.state.value.agents.dsh?.sessions?.map(session => session.id), ["dsh-kept"]);
});

test("a failing package query projection cannot block another Agent or leave scanning busy", async () => {
  const bad = entry("dsh");
  const model = createRouteAgentScanController({ route: () => ({ id: "route" } as GatewayDefinition), catalog: () => [
    { ...bad, renderer: { ...bad.renderer, agentScanQuery() { throw new Error("broken package query"); } } }, entry("codex")
  ], fetcher: async () => result("codex", ["working-task"]) });
  await model.scanAll();
  assert.equal(model.state.value.agents.codex?.sessions?.[0].id, "working-task");
  assert.match(model.errors.value.dsh, /broken package query/);
  assert.equal(model.state.value.loading, false);
  assert.equal(model.loading.value.dsh, false);
});

test("Web packages arriving in separate batches each scan once without rescanning earlier owners", async () => {
  const calls: string[] = [];
  let catalog: AgentAdapterCatalogEntry[] = [];
  const model = createRouteAgentScanController({ route: () => ({ id: "route" } as GatewayDefinition), catalog: () => catalog,
    fetcher: async input => { calls.push(String(input)); return result(String(input).includes("/dsh?") ? "dsh" : "codex", ["task"]); } });
  model.enter(); await settle(); assert.equal(calls.length, 0);
  catalog = [entry("codex")]; model.enter(); await settle();
  catalog = [entry("codex"), entry("dsh")]; model.enter(); await settle();
  model.enter(); await settle();
  assert.equal(calls.filter(url => url.includes("/codex?")).length, 1);
  assert.equal(calls.filter(url => url.includes("/dsh?")).length, 1);
});

test("switching Routes aborts old page reads, starts the new scan immediately and never shows the old directory", async () => {
  let route = { id: "A" } as GatewayDefinition;
  const requests: Array<{ url: string; signal: AbortSignal | null | undefined; reply(response: Response): void }> = [];
  const model = createRouteAgentScanController({ route: () => route, catalog: () => [entry("dsh")], fetcher: (input, init) =>
    new Promise(resolve => { requests.push({ url: String(input), signal: init?.signal, reply: resolve }); }) });
  model.enter();
  assert.equal(requests.length, 1);
  route = { id: "B" } as GatewayDefinition;
  model.enter();
  assert.equal(requests[0].signal?.aborted, true);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /selected=B/);
  requests[1].reply(result("dsh", ["B-task"])); await settle();
  requests[0].reply(result("dsh", ["A-task"])); await settle();
  assert.deepEqual(model.state.value.agents.dsh?.sessions?.map(session => session.id), ["B-task"]);
  route = { id: "C" } as GatewayDefinition;
  model.enter();
  assert.deepEqual(model.state.value.agents, {});
  assert.deepEqual(model.state.value.cwdOptions, []);
  requests[2].reply(result("dsh", ["C-task"])); await settle();
});

test("a replaced owner cannot publish a late error over its successor's working scan", async () => {
  let catalog = [entry("codex")];
  const requests: Array<{ signal: AbortSignal | null | undefined; reply(response: Response): void }> = [];
  const model = createRouteAgentScanController({ route: () => ({ id: "route" } as GatewayDefinition), catalog: () => catalog,
    fetcher: (_input, init) => new Promise(resolve => { requests.push({ signal: init?.signal, reply: resolve }); }) });
  model.enter();
  catalog = [{ ...entry("codex"), renderer: { ...entry("codex").renderer, key: "replacement" } }];
  model.enter();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal?.aborted, true);
  requests[1].reply(result("codex", ["new-owner-task"])); await settle();
  requests[0].reply(Response.json({ message: "old owner failed" }, { status: 503 })); await settle();
  assert.equal(model.errors.value.codex, "");
  assert.deepEqual(model.state.value.agents.codex?.sessions?.map(session => session.id), ["new-owner-task"]);
});

test("page disposal aborts only its outstanding read requests and never accepts their late results", async () => {
  let signal: AbortSignal | null | undefined;
  let reply!: (response: Response) => void;
  const model = createRouteAgentScanController({ route: () => ({ id: "route" } as GatewayDefinition), catalog: () => [entry("codex")],
    fetcher: (_url, init) => { signal = init?.signal; return new Promise(resolve => { reply = resolve; }); } });
  const pending = model.scan("codex");
  model.dispose();
  assert.equal(signal?.aborted, true);
  reply(result("codex", ["late-task"])); await pending;
  assert.deepEqual(model.state.value.agents, {});
  assert.equal(model.state.value.loading, false);
  await model.scanAll();
  assert.deepEqual(model.state.value.agents, {});
});
