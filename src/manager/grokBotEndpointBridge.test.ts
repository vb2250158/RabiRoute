import test from "node:test";
import assert from "node:assert/strict";
import { GrokBotClient, GrokBotError, encodeGrokBotSessionId, type GrokBotSendInput, type GrokBotSendStatus } from "../agentAdapters/grokBotClient.js";
import { AgentRequestStore, agentDeliveryPromptHash } from "../agentRequests/store.js";
import { endpointExecutionOptionsHash } from "../agentRequests/executionOptions.js";
import type { PreparedEndpointDelivery } from "../agentRequests/endpointDelivery.js";
import { createGrokBotEndpointBridge, grokBotDeliveryMessageId, readGrokBotNativeOwner } from "./grokBotEndpointBridge.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
import { executeEndpointAgentDelivery } from "../agentRequests/endpointDelivery.js";

function fixture(defaultMain = false) {
  const nativeSessionId = defaultMain ? "" : "session-a";
  const id = encodeGrokBotSessionId("bot-a", nativeSessionId, defaultMain ? { defaultMain: true } : {});
  const state = { account: "account-a", profilePath: "native-profile-a", credentialsError: false, sessionMissing: false, wrongSessionOwner: false,
    switchDuringRead: false, duplicate: false, sendError: false, status: "accepted" as GrokBotSendStatus["status"], wrongStatusIdentity: false,
    unmarkedDefault: false };
  const sends: GrokBotSendInput[] = [], statuses: unknown[][] = [], scopes: string[] = [];
  const config = { profilePath: "native-profile-a" };
  const client = {
    backendUrl: "https://native.example/",
    profileStatus: async () => {
      if (state.credentialsError) throw new GrokBotError("GROK_BOT_CREDENTIAL_UNREADABLE");
      return { signedIn: true as const, accountScope: state.account, profilePath: state.profilePath };
    },
    listBots: async () => ({ bots: [{ agentId: "bot-a", name: "Native Bot A" }], truncated: false }),
    listSessions: async (agentId: string) => {
      if (state.switchDuringRead) state.account = "account-switched";
      return state.sessionMissing ? [] : [{ agentId: state.wrongSessionOwner ? "foreign-bot" : agentId, sessionId: nativeSessionId,
        ...(defaultMain && !state.unmarkedDefault ? { defaultMain: true as const } : {}), updatedAtMs: "123" }];
    },
    sendNative: async (input: GrokBotSendInput, expectedScope?: string) => {
      if (expectedScope !== state.account) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
      scopes.push(expectedScope); sends.push(input);
      if (state.sendError) throw new GrokBotError("GROK_BOT_DELIVERY_UNCONFIRMED", { uncertain: true });
      return { accepted: true as const, agentId: input.agentId, sessionId: input.sessionId, messageId: input.messageId, duplicate: state.duplicate, recovered: false };
    },
    getSendStatus: async (...args: unknown[]) => {
      statuses.push(args);
      if (args[3] !== state.account) throw new GrokBotError("GROK_BOT_ACCOUNT_CHANGED");
      return { status: state.status, ...(state.wrongStatusIdentity ? { agentId: "foreign-bot" } : {}) };
    }
  } as unknown as GrokBotClient;
  const bridge = createGrokBotEndpointBridge({ managerInstanceId: "manager", configuration: () => config, client });
  const request = { action: "send" as const, agentAdapter: "grokBot" as const, threadId: id,
    sourceThreadId: id, sourceAgentType: "agent" as const,
    messageSource: { type: "agent" as const, agentAdapter: "grokBot" as const, sessionId: id, sessionName: "Declared display name" } };
  const prepared = async () => {
    const target = (await bridge.resolveTarget(request))!;
    const source = { endpoint: { kind: "local" as const, provider: "codex", managerInstanceId: "manager", agentId: "local:codex", sessionId: "source", authorizationIncarnation: "source-epoch" },
      agentAdapter: "codex" as const, agentType: "agent", threadId: "source" };
    const prompt = "[消息源]\n已准备的唯一消息包\n[消息内容]\nScoped prompt";
    const delivery: PreparedEndpointDelivery = { deliveryId: "original-delivery", generation: "generation-original", source: source.endpoint, target: target.endpoint!,
      prompt, promptHash: agentDeliveryPromptHash(prompt), executionOptions: {}, executionOptionsHash: endpointExecutionOptionsHash({}), state: "dispatching",
      preparation: { deliveryId: "original-delivery", source, target, responsePolicy: "none" } };
    return delivery;
  };
  return { id, state, sends, statuses, scopes, config, client, bridge, request, prepared };
}

test("service endpoint uses the native canonical owner and context principal instead of body authority", async () => {
  const f = fixture();
  const source = (await f.bridge.resolveSource(f.request))!;
  assert.equal(source.threadId, f.id);
  assert.equal(source.threadName, "Native Bot A");
  assert.equal(source.workspace, undefined);
  assert.equal(source.endpoint?.kind, "service");
  assert.equal(source.endpoint?.agentId, "bot-a");
  assert.equal(source.endpoint?.provider, "grokBot");
  const principal = { provider: "grokBot" as const, agentId: "bot-a", sessionId: f.id, authorizationIncarnation: source.endpoint!.authorizationIncarnation };
  assert.equal((await f.bridge.resolveSource(f.request, principal))?.threadId, f.id);
  await assert.rejects(() => f.bridge.resolveSource(f.request, { ...principal, authorizationIncarnation: "forged" }), { code: "GROK_BOT_SESSION_OWNER_MISMATCH" });
  const missing = encodeGrokBotSessionId("bot-a", "missing-session");
  await assert.rejects(() => f.bridge.resolveSource({ ...f.request, sourceThreadId: missing,
    messageSource: { ...f.request.messageSource, sessionId: missing }, servicePrincipal: principal, authorizationIncarnation: principal.authorizationIncarnation } as typeof f.request),
    { code: "GROK_BOT_SESSION_NOT_FOUND" });
  assert.deepEqual(f.bridge.resolveExecutionOptions(f.request, source), {});
  assert.throws(() => f.bridge.resolveExecutionOptions({ ...f.request, cwd: "local-directory" }, source), { code: "GROK_BOT_PC_EXECUTION_OPTIONS_UNSUPPORTED" });
});

test("refresh invalidates original owner proof on account/profile changes, unavailable credentials and missing or foreign sessions", async () => {
  for (const change of ["account", "profile", "credentials", "missing", "foreign"] as const) {
    const f = fixture();
    const party = (await f.bridge.resolveTarget(f.request))!;
    f.bridge.authorize(party.endpoint!);
    if (change === "account") f.state.account = "new-account";
    if (change === "profile") f.state.profilePath = "new-native-profile";
    if (change === "credentials") f.state.credentialsError = true;
    if (change === "missing") f.state.sessionMissing = true;
    if (change === "foreign") f.state.wrongSessionOwner = true;
    await assert.rejects(() => f.bridge.refresh!(party.endpoint!));
    assert.throws(() => f.bridge.authorize(party.endpoint!), { code: "GROK_BOT_OWNER_PROOF_UNAVAILABLE" });
    assert.equal(f.sends.length, 0);
  }
  const f = fixture();
  const party = (await f.bridge.resolveTarget(f.request))!;
  f.config.profilePath = "new-configured-profile";
  assert.throws(() => f.bridge.authorize(party.endpoint!), { code: "GROK_BOT_OWNER_PROOF_UNAVAILABLE" });
  f.state.switchDuringRead = true;
  await assert.rejects(() => readGrokBotNativeOwner(f.id, f.config, f.client), { code: "GROK_BOT_ACCOUNT_CHANGED" });
});

test("prepared prompt enters only exact native owner and duplicate acceptance preserves the original delivery receipt", async () => {
  const f = fixture();
  const delivery = await f.prepared();
  f.state.duplicate = true;
  const accepted = (await f.bridge.transport(delivery, () => {}, false))!;
  assert.deepEqual(f.sends[0], { agentId: "bot-a", sessionId: "session-a", messageId: grokBotDeliveryMessageId(delivery.deliveryId, f.id), text: delivery.prompt });
  assert.deepEqual(f.scopes, ["account-a"]);
  assert.match(f.sends[0].messageId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(accepted.deliveryId, delivery.deliveryId);
  assert.equal(accepted.generation, delivery.generation);
  assert.equal(accepted.promptHash, delivery.promptHash);
  assert.equal(accepted.executionOptionsHash, delivery.executionOptionsHash);
  assert.deepEqual(accepted.endpoint, delivery.target);
  assert.equal(accepted.action, "duplicate_accepted");
  assert.equal(accepted.transport, "native-cloud-owner-http");
});

test("proved default-main keeps its canonical endpoint and native empty address only with the explicit marker", async () => {
  const f = fixture(true);
  const owner = await readGrokBotNativeOwner(f.id, f.config, f.client);
  assert.equal(owner.id, f.id);
  assert.equal(owner.defaultMain, true);
  assert.equal(owner.sessionId, "");
  const source = (await f.bridge.resolveSource(f.request))!;
  assert.equal(source.threadId, f.id);
  await assert.rejects(() => f.bridge.resolveSource({ ...f.request, sourceThreadId: "" }), { field: "sourceThreadId" });
  const delivery = await f.prepared();
  assert.equal(delivery.target.sessionId, f.id);
  await f.bridge.transport(delivery, () => {}, false);
  assert.deepEqual(f.sends[0], { agentId: "bot-a", sessionId: "", defaultMain: true,
    messageId: grokBotDeliveryMessageId(delivery.deliveryId, f.id), text: delivery.prompt });
  await f.bridge.transport(delivery, () => {}, true);
  assert.deepEqual(f.statuses[0], ["bot-a", "", grokBotDeliveryMessageId(delivery.deliveryId, f.id), "account-a", { defaultMain: true }]);
  assert.equal(f.sends.length, 1);
  f.state.unmarkedDefault = true;
  await assert.rejects(() => f.bridge.refresh!(delivery.target), { code: "GROK_BOT_SESSION_NOT_FOUND" });
  assert.throws(() => f.bridge.authorize(delivery.target), { code: "GROK_BOT_OWNER_PROOF_UNAVAILABLE" });
  assert.equal(f.sends.length, 1);
});

test("lost native receipt reconciles the original tuple and never sends another prompt", async () => {
  const f = fixture();
  const delivery = await f.prepared();
  f.state.sendError = true;
  await assert.rejects(() => f.bridge.transport(delivery, () => {}, false), { code: "GROK_BOT_DELIVERY_UNCONFIRMED" });
  const recovered = (await f.bridge.transport(delivery, () => {}, true))!;
  assert.equal(recovered.action, "receipt_recovered");
  assert.deepEqual(f.statuses[0], ["bot-a", "session-a", grokBotDeliveryMessageId(delivery.deliveryId, f.id), "account-a", undefined]);
  assert.equal(f.sends.length, 1);
  for (const status of ["pending", "not-found", "unknown-durability"] as const) {
    f.state.status = status;
    assert.equal(await f.bridge.transport(delivery, () => {}, true), undefined);
  }
  f.state.status = "rejected";
  await assert.rejects(() => f.bridge.transport(delivery, () => {}, true), { code: "GROK_BOT_DELIVERY_REJECTED" });
  f.state.status = "accepted"; f.state.wrongStatusIdentity = true;
  await assert.rejects(() => f.bridge.transport(delivery, () => {}, true), { code: "GROK_BOT_RECEIPT_OWNER_MISMATCH" });
  assert.equal(f.sends.length, 1);
});

test("native bridge participates in the common durable ledger and stable caller retries recover without another native send", async () => {
  const f = fixture();
  let persisted: unknown;
  const store = new AgentRequestStore({ read: () => persisted, write: value => { persisted = structuredClone(value); } });
  const context = { store, registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {},
    receiptDirectory: "unused-native-receipts", service: f.bridge,
    localOptions: () => ({ allowedWorkspaces: [] }),
    readLocal: async (_provider: unknown, id: string) => ({ id, title: "Actual source task", updatedAt: "", archived: false, cwd: process.cwd() })
  } as unknown as AgentEndpointDeliveryContext;
  const options = createAgentEndpointDelivery(context).options();
  const request = { action: "send" as const, agentAdapter: "grokBot" as const, threadId: f.id, deliveryId: "caller-native-operation",
    prompt: "One scoped native prompt", responsePolicy: "none" as const, sourceAgentType: "plan_agent" as const, sourceThreadId: "codex-source",
    messageSource: { type: "agent" as const, agentAdapter: "codex" as const, sessionId: "codex-source", sessionName: "Source task" } };
  f.state.sendError = true;
  const uncertain = await executeEndpointAgentDelivery(request, options);
  assert.equal(uncertain.statusCode, 202);
  const recovered = await executeEndpointAgentDelivery(request, options);
  assert.equal(recovered.statusCode, 200);
  assert.equal((uncertain.data.delivery as { deliveryId: string }).deliveryId, (recovered.data.delivery as { deliveryId: string }).deliveryId);
  assert.equal(f.sends.length, 1);
  assert.equal(new AgentRequestStore({ read: () => persisted, write: () => {} }).listEndpointDeliveries()[0].state, "committed");
  assert.equal(store.listEndpointDeliveries()[0].target.kind, "service");
});

test("trusted configuration selection receives the exact canonical owner and rejects conflicting profile mappings", async () => {
  const f = fixture();
  const selected: Array<string | undefined> = [];
  let conflict = false;
  const bridge = createGrokBotEndpointBridge({ managerInstanceId: "manager", client: f.client, configuration: id => {
    selected.push(id);
    if (conflict) throw new GrokBotError("GROK_BOT_PROFILE_BINDING_CONFLICT");
    return { profilePath: "owner-specific-profile" };
  } });
  const party = (await bridge.resolveTarget(f.request))!;
  bridge.authorize(party.endpoint!);
  await bridge.refresh!(party.endpoint!);
  assert.ok(selected.length >= 3);
  assert.equal(selected.every(id => id === f.id), true);
  conflict = true;
  await assert.rejects(() => bridge.resolveTarget(f.request), { code: "GROK_BOT_PROFILE_BINDING_CONFLICT" });
  assert.equal(f.sends.length, 0);
});
