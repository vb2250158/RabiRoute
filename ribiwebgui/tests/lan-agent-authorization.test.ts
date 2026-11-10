import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { peerManagerPath } from "../src/peerManagerTarget.js";
import { ComputerControlClient } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlClient";
import { createComputerControlState } from "../../src/plugins/io.rabiroute.manager.core/web/computer/computerControlState";
import { normalizeComputerSettings, computerSettingsSchema } from "../../src/shared/agentInteractiveProtocol";
import { agentInstanceDisplayName } from "../../src/shared/agentInstance.js";

const settingsSource = fs.readFileSync(new URL("../src/components/InstanceAgentSettings.vue", import.meta.url), "utf8");
const pageSource = fs.readFileSync(new URL("../src/pages/LanAgentsPage.vue", import.meta.url), "utf8");
type Reply = Response | Promise<Response>;
function evaluate(source: string, exposed: string, context: Record<string, unknown>) {
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*;\r?\n/gm, "");
  const code = ts.transpileModule(script + `\nreturn { ${exposed} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(`(function() { ${code} })()`, {
    ref: (value: unknown) => ({ value }), computed: (read: () => unknown) => ({ get value() { return read(); } }), onMounted: () => {}, onBeforeUnmount: () => {}, watch: () => {},
    peerManagerPath, agentInstanceDisplayName, AbortController,
    managerAccessToken: () => "fixture-fallback", userFacingError: String, ...context
  });
}
function requests(responses: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return { calls, fetch: async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/api/lan-agent/nodes")) return Response.json({ code: 0, nodes: [], tasks: [] });
    if (url.endsWith("/meta")) return Response.json({});
    if (url === "/api/rabilink/peer/servers") return Response.json({ peers: [] });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request: ${url}`);
    return response;
  } };
}
function settings(responses: Reply[], local = false, agentId = "agent-fixture") {
  const transport = requests(responses);
  const agent = { agentId, enabled: false, name: "Fixture", workspace: "fixture-workspace", provider: "dsh", sessionId: "saved-session", managedSessionIds: ["saved-managed"] };
  const instance = { instanceId: "node:fixture", name: "Display alias", address: "192.0.2.1", local, connected: true, enabled: true };
  const events: string[] = [];
  const state = evaluate(settingsSource, "error, notice, save, draft, busy, openTask, selectedSessionId", {
    ...transport, defineProps: () => ({ instance, agent }), defineEmits: () => (name: string) => events.push(name)
  });
  return { state, ...transport, agent, instance, events };
}
function page(responses: Reply[], deviceId = "") {
  const transport = requests(responses);
  const state = evaluate(pageSource, "instances, error, connectionToken, refresh, connectionAvailable", {
    ...transport, window: { location: { origin: "https://manager.test", hostname: "manager.test" } }, useGatewayStore: () => ({ gateways: [] }),
    useRoute: () => ({ query: { deviceId } }), useRouter: () => ({ replace: () => {} })
  });
  state.connectionToken.value = "fixture-admin";
  return { state, ...transport };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const access = () => json({ code: 0, data: { token: "fixture-admin", enabled: false } });
const saved = () => json({ code: 0, result: { saved: true } });
const instance = (enabled?: boolean) => ({ instanceId: "node:fixture", name: "Display alias", address: "192.0.2.1", local: false, connected: false, enabled, agents: [] });
const catalog = (enabled: boolean) => json({ code: 0, instances: [instance(enabled)] });
const payload = (call: { init?: RequestInit }) => JSON.parse(String(call.init?.body));

test("computer settings own the visible switches while the Agent page links to that owner", () => {
  const rowSource=fs.readFileSync(new URL("../../src/plugins/io.rabiroute.manager.core/web/computer/ComputerControlRow.vue",import.meta.url),"utf8");
  assert.doesNotMatch(pageSource,/setInstanceEnabled|captureScreen|RemoteTerminalDialog/);
  assert.match(pageSource,/tab:'computer'/);assert.match(rowSource,/edit\(\['enabled'\],\$event\)/);
  assert.match(settingsSource,/v-switch v-if="instance.local" v-model="draft.enabled" label="启用此执行程序"/);
  assert.doesNotMatch(settingsSource,/setAuthorization|authorized|\/authorization/);
});

test("remote save persists execution parameters by stable IDs without changing instance enable or saved session bindings", async () => {
  const { state, calls, instance: target, events } = settings([access(), saved()]);
  state.draft.value.enabled = false;
  state.draft.value.sessionId = "unsaved-session";
  state.draft.value.managedSessionIds = ["unsaved-managed"];
  state.draft.value.workspace = "new-workspace";
  target.name = "Renamed alias";
  target.address = "192.0.2.2";
  await state.save();
  assert.equal(calls[1].url, "/api/lan-agent/instances/node%3Afixture/agents/agent-fixture/configure");
  assert.equal(calls[1].init?.method, "POST");
  const body = payload(calls[1]);
  for (const key of ["enabled", "sessionId", "managedSessionIds"]) assert.equal(Object.hasOwn(body, key), false);
  assert.equal(body.workspace, "new-workspace");
  assert.equal(target.enabled, true);
  assert.deepEqual(events, ["saved"]);
  assert.match(state.notice.value, /已保存/);
});

test("local save retains local executor enable and session configuration", async () => {
  const { state, calls } = settings([access(), saved()], true);
  state.draft.value.enabled = true;
  state.draft.value.sessionId = "selected-local-session";
  await state.save();
  assert.equal(payload(calls[1]).enabled, true);
  assert.equal(payload(calls[1]).sessionId, "selected-local-session");
  assert.deepEqual(payload(calls[1]).managedSessionIds, ["saved-managed"]);
});

test("connected host settings keep the target PC and need no second login", async () => {
  const { state, calls, instance } = settings([access(), saved()], true);
  Object.assign(instance, { ownerDeviceId: "pc-b" });
  await state.save();
  assert.equal(calls[1].url, "/api/rabilink/peer/http/pc-b/manager/api/lan-agent/instances/node%3Afixture/agents/agent-fixture/configure");
  assert.equal(calls.length, 2);
});

test("connected host catalog loads through Peer even when local LAN enrollment is disabled", async () => {
  const { state, calls } = page([access(), catalog(true)], "pc-b");
  await state.refresh();
  assert.equal(state.instances.value[0].ownerDeviceId, "pc-b");
  assert.ok(calls.some(call => call.url === "/api/rabilink/peer/http/pc-b/manager/api/lan-agent/instances"));
  assert.equal(calls.filter(call => call.init?.method === "POST").length, 0);
  assert.equal(state.error.value, "");
  assert.equal(state.connectionAvailable.value, false, "missing target enrollment metadata does not borrow local readiness");
});

// Screenshot ordering now runs against the actual Core ComputerControlRow SFC in computer-control-ui.test.ts.

test("failed save retains edited draft and emits no saved result", async () => {
  const { state, events, calls } = settings([access(), json({ code: -1, message: "fixture save rejected" }, 503)]);
  state.draft.value.workspace = "keep-my-draft";
  await state.save();
  assert.equal(state.draft.value.workspace, "keep-my-draft");
  assert.match(state.error.value, /fixture save rejected/);
  assert.equal(state.notice.value, "");
  assert.deepEqual(events, []);
  assert.equal(calls.length, 2);
  assert.equal(state.busy.value, false);
});

test("executor failure inside a successful HTTP envelope is not reported as saved", async () => {
  const { state, events } = settings([access(), json({ code: 0, result: { statusCode: 409, data: { message: "execution conflict" } } })]);
  await state.save();
  assert.match(state.error.value, /execution conflict/);
  assert.deepEqual(events, []);
  assert.equal(state.notice.value, "");
});

test("new execution settings use instance collection creation without a synthetic agent identity", async () => {
  const { state, calls } = settings([access(), saved()], false, "");
  await state.save();
  assert.equal(calls[1].url, "/api/lan-agent/instances/node%3Afixture/agents");
  assert.equal(payload(calls[1]).provider, "dsh");
});

test("remote open uses the explicitly selected full session ID only for that operation", async () => {
  const { state, calls, agent } = settings([access(), json({ code: 0, result: { opened: true } })]);
  state.selectedSessionId.value = "full-selected-session";
  await state.openTask();
  assert.equal(payload(calls[1]).threadId, "full-selected-session");
  assert.equal(payload(calls[1]).action, "open");
  assert.equal(agent.sessionId, "saved-session");
  assert.equal(calls[1].url, "/api/lan-agent/instances/node%3Afixture/agents/agent-fixture/threads");
});

function computerSettingsOwner(responses:Reply[],initialEnabled?:boolean) {
 const transport=requests(responses),owner=createComputerControlState(),target={...instance(initialEnabled),id:"fixture",kind:"node" as const,status:"offline" as const};
 owner.acceptSettings(target.id,{settings:normalizeComputerSettings(undefined,initialEnabled ?? true),schema:computerSettingsSchema,etag:'"v1"'});
 const client=new ComputerControlClient(transport.fetch as typeof fetch,"fixture-admin");
 async function save(enabled:boolean){const draft=owner.state.drafts.get(target.id)!;draft.value.enabled=enabled;draft.changes.set("enabled",enabled);draft.revision++;await owner.save(target.id,{enabled},(patch,etag)=>client.saveSettings(target,patch,etag));}
 return {owner,target,draft:owner.state.drafts.get(target.id)!,save,...transport};
}
const computerReply=(enabled:boolean,revision='"v2"')=>Response.json({code:0,data:{settings:normalizeComputerSettings(undefined,enabled),schema:computerSettingsSchema,revision,execution:"applied"}},{headers:{etag:revision}});
test("offline computer disable uses its stable ID, original CAS and authoritative readback",async()=>{
 const f=computerSettingsOwner([computerReply(false),computerReply(false)],true);await f.save(false);
 assert.equal(f.calls[0].url,"/api/lan-agent/instances/node%3Afixture/computer-settings");assert.equal(f.calls[0].init?.method,"PATCH");assert.deepEqual(payload(f.calls[0]),{enabled:false});
 assert.equal(new Headers(f.calls[0].init?.headers).get("if-match"),'"v1"');assert.equal(new Headers(f.calls[0].init?.headers).get("x-rabiroute-webgui-token"),"fixture-admin");
 assert.equal(f.draft.saved.settings.enabled,false);assert.equal(f.draft.error,"");assert.equal(f.target.enabled,true,"the old directory snapshot is not optimistically rewritten");
});
test("an older computer without enabled metadata keeps the owner default-enabled comparison",async()=>{const f=computerSettingsOwner([computerReply(false),computerReply(false)]);assert.equal(f.draft.saved.settings.enabled,true);await f.save(false);assert.equal(new Headers(f.calls[0].init?.headers).get("if-match"),'"v1"');assert.equal(f.draft.saved.settings.enabled,false);});
test("rejected computer change retains owner state and edited draft without retry",async()=>{const f=computerSettingsOwner([json({code:-1,message:"instance changed concurrently"},409)],true);await f.save(false);assert.equal(f.draft.saved.settings.enabled,true);assert.equal(f.draft.value.enabled,false);assert.match(f.draft.error,/instance changed concurrently/);assert.equal(f.calls.length,1);assert.equal(f.draft.saving,false);});
test("successful settings write with different readback remains submitted and unconfirmed",async()=>{const f=computerSettingsOwner([computerReply(false),computerReply(true,'"v3"')],true);await f.save(false);assert.equal(f.draft.saved.settings.enabled,true);assert.equal(f.draft.value.enabled,false);assert.equal(f.draft.readbackUnconfirmed,true);assert.match(f.draft.application?.readbackIssue || "",/修改已提交/);assert.equal(f.calls.filter(call=>call.init?.method==="PATCH").length,1);});
test("pending computer and executor writes do not duplicate original requests",async()=>{
 let release!:(response:Response)=>void;const held=new Promise<Response>(yes=>release=yes);const f=computerSettingsOwner([held,computerReply(false)],true);const pending=f.save(false);
 await f.owner.save(f.target.id,{enabled:true},()=>{throw new Error("duplicate write must not dispatch");});await f.owner.save(f.target.id,{enabled:"false"},()=>{throw new Error("duplicate write must not dispatch");});assert.equal(f.calls.length,1);release(computerReply(false));await pending;
 let releaseAccess!:(response:Response)=>void;const heldAccess=new Promise<Response>(yes=>releaseAccess=yes);const execution=settings([heldAccess,saved()]);const saving=execution.state.save();await execution.state.save();assert.equal(execution.calls.length,1);releaseAccess(access());await saving;assert.deepEqual(execution.events,["saved"]);assert.equal(execution.calls.length,2);
});
