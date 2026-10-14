import assert from "node:assert/strict";
import test from "node:test";
import { reactive } from "vue";
import { cloneGatewayValue, mergeGatewayDraft } from "../src/gatewayDraft";
import { createGrokBotRouteScan, grokBotSessionPickerItems, maxGrokBotSessionItems,
  mergeGrokBotSessionPage, selectGrokBotRouteSession } from "../src/grokBotRouteConfig";
import type { AgentScanResult, AgentScanSession, GatewayDefinition } from "../src/types";

const sessionId = "grokBot:WyJleGFtcGxlLW93bmVyIiwiZXhhbXBsZS1zZXNzaW9uIl0";
const session: AgentScanSession = { id: sessionId, name: "Example Bot", ownerId: "example-owner", live: true };
function route(): GatewayDefinition {
  return { id: "route-example", agentAdapters: ["grokBot"], primaryAgentAdapter: "grokBot",
    grokBotProfilePath: "C:/Example/GrokProfile", grokBotBackendUrl: "https://owner.example/" } as GatewayDefinition;
}
function scan(sessions: AgentScanSession[], offset = 0, hasMore = false): AgentScanResult {
  return { type: "grokBot", label: "Grok Bot", maturity: "experimental", installed: true, sessions,
    bots: [{ agentId: "example-owner", name: "Example Bot" }],
    sessionPage: { offset, limit: 100, returned: sessions.length, hasMore, ...(hasMore ? { nextOffset: offset + sessions.length } : {}) } };
}
function response(value: AgentScanResult): Response { return Response.json({ agents: { grokBot: value } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("selection and the shared Route save/reload merge preserve all five Grok fields", () => {
  const baseline = route();
  const draft = cloneGatewayValue(baseline);
  assert.equal(selectGrokBotRouteSession(draft, [session], sessionId), true);
  const current = { ...baseline, name: "Independently renamed Route" };
  const saved = mergeGatewayDraft(baseline, draft, current);
  const reloaded = cloneGatewayValue(saved);
  assert.equal(reloaded.grokBotProfilePath, "C:/Example/GrokProfile");
  assert.equal(reloaded.grokBotBackendUrl, "https://owner.example/");
  assert.equal(reloaded.grokBotAgentId, "example-owner");
  assert.equal(reloaded.grokBotSessionId, sessionId);
  assert.equal(reloaded.grokBotSessionName, "Example Bot");
  assert.equal(reloaded.name, current.name);
  assert.equal("codexThreadId" in reloaded, false);
  assert.equal("codexCwd" in reloaded, false);
});

test("unknown and ownerless selections cannot replace a saved identity; display renames keep the ID", () => {
  const draft = route();
  selectGrokBotRouteSession(draft, [session], sessionId);
  const before = cloneGatewayValue(draft);
  assert.equal(selectGrokBotRouteSession(draft, [], "invented-id"), false);
  assert.equal(selectGrokBotRouteSession(draft, [{ id: "ownerless", name: "Unverified" }], "ownerless"), false);
  assert.deepEqual(draft, before);
  const renamed = { ...session, name: "Renamed Bot" };
  assert.equal(grokBotSessionPickerItems(draft, [renamed])[0].title, "Renamed Bot");
  assert.equal(draft.grokBotSessionId, sessionId);
  assert.equal(grokBotSessionPickerItems(draft, [])[0].value, sessionId);
  assert.equal(grokBotSessionPickerItems(draft, [])[0].props.disabled, true);
});

test("entry scan reuse and draft edits cause no requests; explicit search and more use only the Grok catalog", async () => {
  const draft = reactive(route());
  const calls: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://manager.example"); calls.push(url);
    return calls.length === 1 ? response(scan([session], 0, true))
      : response(scan([{ ...session, name: "Renamed Bot" }, { id: "second-session", name: "Second", ownerId: "example-owner" }], 1));
  }) as typeof fetch;
  const controller = createGrokBotRouteScan(() => draft, fetcher);
  controller.seed(scan([session]), cloneGatewayValue(draft), controller.revision);
  draft.grokBotBackendUrl = "https://other-owner.example/";
  draft.grokBotProfilePath = "C:/Example/OtherProfile";
  draft.grokBotAgentId = "example-owner";
  assert.equal(calls.length, 0);
  assert.equal(controller.needsRefresh.value, true);
  await controller.loadMore();
  assert.equal(calls.length, 0);
  controller.state.queryDraft = "Example Bot";
  assert.equal(calls.length, 0);
  await controller.refresh();
  controller.state.queryDraft = "Other Bot";
  await controller.loadMore();
  assert.equal(controller.state.queryDraft, "Other Bot");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.pathname === "/api/scan/agents/grokBot"));
  assert.equal(calls[0].searchParams.get("grokBotBackendUrl"), "https://other-owner.example/");
  assert.equal(calls[0].searchParams.get("grokBotProfilePath"), "C:/Example/OtherProfile");
  assert.equal(calls[0].searchParams.get("grokBotAgentId"), "example-owner");
  assert.equal(calls[0].searchParams.get("grokBotLimit"), "100");
  assert.equal(calls[1].searchParams.get("grokBotOffset"), "1");
  assert.equal(calls[1].searchParams.get("grokBotQuery"), "Example Bot");
  assert.deepEqual(controller.state.result?.sessions?.map(item => item.id), [sessionId, "second-session"]);
  assert.equal(controller.state.result?.sessions?.[0].name, "Renamed Bot");
  controller.dispose();
});

test("late entry scan cannot overwrite an explicitly refreshed Grok page", async () => {
  const draft = route();
  const controller = createGrokBotRouteScan(() => draft, (async () => response(scan([session]))) as typeof fetch);
  const entryRevision = controller.revision;
  await controller.refresh();
  controller.seed(scan([{ id: "stale-session", name: "Stale", ownerId: "other" }]), draft, entryRevision);
  assert.equal(controller.state.result?.sessions?.[0].id, sessionId);
  controller.dispose();
});

test("A to B to A switches discard an old response even when abort is ignored", async () => {
  const draft = reactive(route());
  const first = deferred<Response>(), second = deferred<Response>();
  let calls = 0;
  const controller = createGrokBotRouteScan(() => draft, (async () => ++calls === 1 ? first.promise : second.promise) as typeof fetch);
  const oldRequest = controller.refresh("old");
  draft.grokBotBackendUrl = "https://other-owner.example/";
  draft.grokBotBackendUrl = "https://owner.example/";
  const newRequest = controller.refresh("new");
  second.resolve(response(scan([session])));
  await newRequest;
  first.resolve(response(scan([{ id: "stale", name: "Stale", ownerId: "other" }])));
  await oldRequest;
  assert.equal(controller.state.appliedQuery, "new");
  assert.equal(controller.state.result?.sessions?.[0].id, sessionId);
  controller.dispose();
});

test("a failed refresh preserves cached rows and exposes the owner repair message", async () => {
  const draft = route();
  const controller = createGrokBotRouteScan(() => draft,
    (async () => Response.json({ message: "Grok Bot 登录已过期，请恢复登录后重新扫描。" }, { status: 401 })) as typeof fetch);
  controller.seed(scan([session]), draft, controller.revision);
  await controller.refresh();
  assert.equal(controller.state.result?.sessions?.[0].id, sessionId);
  assert.match(controller.state.error, /恢复登录/);
  assert.equal(controller.state.loading, false);
  controller.dispose();
});

test("unmount ignores late results; the scan cache remains bounded", async () => {
  const draft = route();
  const pending = deferred<Response>();
  const controller = createGrokBotRouteScan(() => draft, (async () => pending.promise) as typeof fetch);
  const request = controller.refresh();
  controller.dispose();
  pending.resolve(response(scan([session])));
  await request;
  assert.equal(controller.state.result, null);
  assert.equal(controller.state.loading, false);
  const large = scan(Array.from({ length: maxGrokBotSessionItems + 20 }, (_, index) => ({ id: `example-session-${index}`, name: "Example", ownerId: "example-owner" })));
  assert.equal(mergeGrokBotSessionPage(null, large, false).sessions?.length, maxGrokBotSessionItems);
});
