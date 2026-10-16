import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GrokBotClient, GrokBotError, encodeGrokBotSessionId } from "../agentAdapters/grokBotClient.js";
import { handleGrokBotThreadRequest } from "./grokBotThreads.js";

function fixture(defaultMain = false) {
  const calls: unknown[][] = [];
  const state = { sessionMissing: false, account: "account-a", unavailable: false };
  const client = { backendUrl: "https://native.example/",
    profileStatus: async () => { if (state.unavailable) throw new GrokBotError("GROK_BOT_NOT_SIGNED_IN"); return { signedIn: true, accountScope: state.account }; },
    listBots: async () => ({ bots: [{ agentId: "bot-a", name: "Native Alpha" }, { agentId: "bot-b", name: "Native Beta" }], truncated: false }),
    listSessions: async (agentId: string) => { calls.push(["listSessions", agentId]); return state.sessionMissing ? [] :
      [{ agentId, sessionId: defaultMain ? "" : `${agentId}-session`, ...(defaultMain ? { defaultMain: true as const } : {}),
        updatedAtMs: agentId === "bot-a" ? "2000" : "1000" }]; },
    readTranscript: async (...args: unknown[]) => { calls.push(["readTranscript", ...args]); return { entries: [{ text: "native entry" }], generation: 1, cloudAgentPeerIds: [], cloudAgentPeerIdsKnown: true }; }
  } as unknown as GrokBotClient;
  return { client, calls, state, id: encodeGrokBotSessionId("bot-a", defaultMain ? "" : "bot-a-session", defaultMain ? { defaultMain: true } : {}) };
}

test("native default-main discovery and read retain a nonempty canonical identity and the explicit native marker", async () => {
  const f = fixture(true);
  const listed = (await handleGrokBotThreadRequest({ action: "list", agentAdapter: "grokBot" }, {}, f.client))!;
  const thread = (listed.data.threads as Array<{ id: string; defaultMain?: true }>)[0];
  assert.equal(thread.id, f.id);
  assert.equal(thread.defaultMain, true);
  assert.ok(thread.id.length > 0);
  const read = (await handleGrokBotThreadRequest({ action: "read", agentAdapter: "grokBot", threadId: f.id }, {}, f.client))!;
  assert.equal(read.statusCode, 200);
  assert.equal((read.data.thread as { defaultMain?: true }).defaultMain, true);
  const call = f.calls.find(item => item[0] === "readTranscript")!;
  assert.deepEqual(call, ["readTranscript", "bot-a", "", { limit: 50, accountScope: "account-a", defaultMain: true }]);
});

test("native cloud list exposes canonical IDs and real names with query and pagination", async () => {
  const f = fixture();
  const listed = (await handleGrokBotThreadRequest({ action: "list", agentAdapter: "grokBot", limit: 1, offset: 0 }, {}, f.client))!;
  assert.equal(listed.statusCode, 200);
  const threads = listed.data.threads as Array<Record<string, unknown>>;
  assert.equal(threads[0].id, f.id);
  assert.equal(threads[0].title, "Native Alpha");
  assert.equal(threads[0].owner, "grok_bot_cloud");
  assert.equal(threads[0].updatedAt, "1970-01-01T00:00:02.000Z");
  assert.equal((listed.data.pagination as { hasMore: boolean }).hasMore, true);
  const queried = (await handleGrokBotThreadRequest({ action: "list", agentAdapter: "grokBot", query: "Beta" }, {}, f.client))!;
  assert.equal((queried.data.threads as Array<{ title: string }>)[0].title, "Native Beta");
  const invalid = (await handleGrokBotThreadRequest({ action: "list", agentAdapter: "grokBot", limit: 0 }, {}, f.client))!;
  assert.equal((invalid.data.error as { code: string }).code, "GROK_BOT_PAGE_INVALID");
});

test("room summaries expose native kind and members without confusing session kind", async () => {
  const f = fixture(true);
  f.client.listBots = async () => ({ bots: [{ agentId: "bot-a", name: "Room", kind: 2, memberAgentIds: ["bot-b"] }], truncated: false });
  const listed = (await handleGrokBotThreadRequest({ action: "list", agentAdapter: "grokBot" }, {}, f.client))!;
  const thread = (listed.data.threads as Array<Record<string, unknown>>)[0];
  assert.equal(thread.kind, 2);
  assert.equal(thread.nativeAgentId, "bot-a");
  assert.deepEqual(thread.memberAgentIds, ["bot-b"]);
  const resolved = (await handleGrokBotThreadRequest({ action: "resolve", agentAdapter: "grokBot", threadId: f.id }, {}, f.client))!;
  assert.equal((resolved.data.thread as Record<string, unknown>).kind, 2);
});

test("explicit delivery sends a plain prompt through shared transport and reconciles without resend", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot-thread-fixture-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const f = fixture(true);
  const sends: unknown[] = [];
  f.client.sendNative = async input => { sends.push(input); return { ...input, accepted: true, duplicate: false, recovered: false }; };
  const request = { action: "send" as const, agentAdapter: "grokBot" as const, threadId: f.id, deliveryId: "caller-original-key", prompt: "One plain line",
    grokBotDelivery: { deliveryType: "group" as const, sendMode: "direct" as const } };
  const sent = (await handleGrokBotThreadRequest(request, { dataDir }, f.client))!;
  assert.equal(sent.statusCode, 200);
  assert.equal((sent.data.delivery as Record<string, unknown>).status, "delivered");
  assert.equal((sent.data.delivery as Record<string, unknown>).deliveryId, request.deliveryId);
  assert.equal(sent.data.targetThreadId, f.id);
  assert.equal(sent.data.threadId, f.id);
  assert.equal((sends[0] as Record<string, unknown>).text, request.prompt);
  assert.equal("fromAgentId" in (sends[0] as object), false);
  const reconciled = (await handleGrokBotThreadRequest({ ...request, action: "reconcile_delivery", prompt: undefined }, { dataDir }, f.client))!;
  assert.equal(reconciled.statusCode, 200);
  assert.equal(sends.length, 1);
  const invalid = (await handleGrokBotThreadRequest({ ...request, deliveryId: "other", grokBotDelivery: { deliveryType: "group", sendMode: "identity" } }, { dataDir }, f.client))!;
  assert.equal((invalid.data.error as Record<string, unknown>).code, "GROK_BOT_DELIVERY_OPTIONS_INVALID");
  const missing = (await handleGrokBotThreadRequest({ ...request, action: "reconcile_delivery", deliveryId: "missing" }, { dataDir }, f.client))!;
  assert.equal(missing.statusCode, 404);
  assert.equal(sends.length, 1);
});

test("read and resolve use the exact native session without creating replacements", async () => {
  const f = fixture();
  const read = (await handleGrokBotThreadRequest({ action: "read", agentAdapter: "grokBot", threadId: f.id }, {}, f.client))!;
  assert.equal(read.statusCode, 200);
  assert.equal((read.data.thread as { id: string }).id, f.id);
  assert.ok(f.calls.some(call => call[0] === "readTranscript" && call[1] === "bot-a" && call[2] === "bot-a-session"));
  const resolved = (await handleGrokBotThreadRequest({ action: "resolve", agentAdapter: "grokBot", threadId: f.id, createIfMissing: true }, {}, f.client))!;
  assert.equal(resolved.data.status, "resolved");
  f.state.sessionMissing = true;
  const missing = (await handleGrokBotThreadRequest({ action: "resolve", agentAdapter: "grokBot", threadId: f.id, createIfMissing: true }, {}, f.client))!;
  assert.equal(missing.statusCode, 404);
  assert.equal((missing.data.error as { code: string }).code, "GROK_BOT_SESSION_NOT_FOUND");
  const malformed = (await handleGrokBotThreadRequest({ action: "read", agentAdapter: "grokBot", threadId: "codex-looking-id" }, {}, f.client))!;
  assert.equal((malformed.data.error as { code: string }).code, "GROK_BOT_SESSION_ID_INVALID");
});

test("open/create/rename are explicit unsupported outcomes and send stays on the common endpoint ledger", async () => {
  const f = fixture();
  for (const action of ["open", "create", "rename"] as const) {
    const result = (await handleGrokBotThreadRequest({ action, agentAdapter: "grokBot", threadId: f.id }, {}, f.client))!;
    assert.equal(result.statusCode, 422);
    assert.equal(result.data.status, "unsupported");
  }
  assert.equal(await handleGrokBotThreadRequest({ action: "send", agentAdapter: "grokBot", threadId: f.id }, {}, f.client), undefined);
  assert.equal(await handleGrokBotThreadRequest({ action: "list", agentAdapter: "codex" }, { backendUrl: "invalid URL" }), undefined);
  assert.equal(f.calls.length, 0);
  f.state.unavailable = true;
  const unavailable = (await handleGrokBotThreadRequest({ action: "list", agentAdapter: "grokBot" }, {}, f.client))!;
  assert.equal((unavailable.data.error as { code: string }).code, "GROK_BOT_NOT_SIGNED_IN");
});
