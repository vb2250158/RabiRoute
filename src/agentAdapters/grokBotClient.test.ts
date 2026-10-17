import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeGrokBotProfileSnapshot, decodeGrokBotSessionId, encodeGrokBotSessionId, GrokBotClient, GrokBotError,
  grokBotMessageId, grokBotProfileScriptPath, readGrokBotNativeProfile, type GrokBotCredentials, type GrokBotProfileSnapshot } from "./grokBotClient.js";

function credentials(): GrokBotCredentials {
  return { signedIn: true, accountScope: "fixture-account", accessToken: "fixture-token", appVersion: "0.70.2" };
}
function fixtureClient(respond: (method: string, body: Record<string, unknown>, headers: Headers) => unknown | Promise<unknown>) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const client = new GrokBotClient({ backendUrl: "http://127.0.0.1:30001/", readProfile: async () => credentials(),
    request: async (input, init) => {
      const method = String(input).split("/").at(-1)!;
      const body = JSON.parse(String(init?.body));
      calls.push({ method, body });
      let result = await respond(method, body, new Headers(init?.headers));
      if (method === "ListGrokBotAgents" && !(result instanceof Response) && !(result && typeof result === "object" && "agents" in result)) {
        result = { agents: [{ agentId: session.agentId, name: "Fixture Bot", harness: "box" }] };
      }
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    } });
  return { client, calls };
}
const session = { agentId: "owner-fixture", sessionId: "native-session-fixture", updatedAtMs: "100" };
const send = { agentId: session.agentId, sessionId: session.sessionId, messageId: "delivery-fixture", text: "Fixture smoke message." };

test("canonical Grok session preserves both opaque identities and rejects noncanonical IDs", () => {
  const id = encodeGrokBotSessionId("owner/opaque", "session:opaque");
  assert.deepEqual(decodeGrokBotSessionId(id), { agentId: "owner/opaque", sessionId: "session:opaque" });
  assert.throws(() => decodeGrokBotSessionId(id + "="), /GROK_BOT_SESSION_ID_INVALID/);
  assert.throws(() => encodeGrokBotSessionId("owner", ""), /GROK_BOT_SESSION_ID_INVALID/);
  assert.throws(() => decodeGrokBotSessionId("native-session"), /GROK_BOT_SESSION_ID_INVALID/);
});
test("native default main address needs the explicit canonical marker and never accepts a plain empty ID", () => {
  const id = encodeGrokBotSessionId("fixture-owner", "", { defaultMain: true });
  assert.deepEqual(decodeGrokBotSessionId(id), { agentId: "fixture-owner", sessionId: "", defaultMain: true });
  assert.throws(() => encodeGrokBotSessionId("fixture-owner", ""), /GROK_BOT_SESSION_ID_INVALID/);
  assert.throws(() => encodeGrokBotSessionId("fixture-owner", "named-session", { defaultMain: true }), /GROK_BOT_SESSION_ID_INVALID/);
  const unmarked = "grokBot:" + Buffer.from(JSON.stringify(["fixture-owner", ""])).toString("base64url");
  assert.throws(() => decodeGrokBotSessionId(unmarked), /GROK_BOT_SESSION_ID_INVALID/);
});
test("Temporal default main is discovered only from native roster and a successful existing transcript read", async () => {
  const { client, calls } = fixtureClient(method => {
    if (method === "ListGrokBotAgentSessions") return {};
    if (method === "ListGrokBotAgents") return { agents: [{ agentId: session.agentId, name: "Fixture Bot", harness: "temporal" }] };
    if (method === "ListGrokBotTranscriptEntries") return { entries: [{ seq: "1", entryId: "existing-entry" }] };
    if (method === "GetGrokBotSendStatus") return { status: "ACCEPTED" };
    return { delivery: "ACCEPTED_TEMPORAL" };
  });
  const sessions = await client.listSessions(session.agentId);
  assert.deepEqual(sessions, [{ agentId: session.agentId, sessionId: "", defaultMain: true, kind: "MAIN" }]);
  const receipt = await client.sendNative({ ...send, sessionId: "", defaultMain: true });
  assert.equal(receipt.sessionId, "");
  assert.equal((await client.getSendStatus(session.agentId, "", send.messageId, "fixture-account", { defaultMain: true })).status, "accepted");
  const nativeSend = calls.find(call => call.method === "SendGrokBotUserMessage")!;
  assert.equal(nativeSend.body.sessionId, "");
  assert.equal("defaultMain" in nativeSend.body, false);
  await assert.rejects(client.sendNative({ ...send, sessionId: "" }), /GROK_BOT_SESSION_ID_INVALID/);
});
test("default discovery cannot invent a session after transcript rejection or missing owner", async () => {
  const denied = fixtureClient(method => {
    if (method === "ListGrokBotAgentSessions") return {};
    if (method === "ListGrokBotAgents") return { agents: [{ agentId: session.agentId, name: "Fixture Bot", harness: "temporal" }] };
    return new Response("private server response", { status: 403 });
  });
  await assert.rejects(denied.client.listSessions(session.agentId), /GROK_BOT_OWNER_REFUSED/);
  const absent = fixtureClient(method => method === "ListGrokBotAgentSessions" ? {} : { agents: [] });
  await assert.rejects(absent.client.listSessions(session.agentId), /GROK_BOT_SESSION_NOT_FOUND/);
  assert.equal(absent.calls.some(call => call.method === "ListGrokBotTranscriptEntries"), false);
  assert.equal(denied.calls.some(call => call.method === "SendGrokBotUserMessage"), false);
});
test("native message UUID is stable for one delivery and changes with canonical owner session", () => {
  const first = encodeGrokBotSessionId("fixture-owner", "fixture-session");
  const second = encodeGrokBotSessionId("fixture-owner", "fixture-session-2");
  const id = grokBotMessageId("fixture-delivery", first);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(grokBotMessageId("fixture-delivery", first), id);
  assert.notEqual(grokBotMessageId("fixture-delivery", second), id);
  assert.notEqual(grokBotMessageId("fixture-delivery-2", first), id);
});
test("profile helper resolves trusted installed resources and never silently changes an explicit override", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot-resource-fixture-"));
  const previous = process.env.RABIROUTE_PACKAGE_ROOT;
  try {
    const helper = path.join(directory, "dist", "scripts", "grok-bot-native-profile.ps1");
    await fs.mkdir(path.dirname(helper), { recursive: true });
    await fs.writeFile(helper, "# fixture resource; never executed");
    process.env.RABIROUTE_PACKAGE_ROOT = directory;
    assert.equal(grokBotProfileScriptPath(), helper);
    assert.equal(grokBotProfileScriptPath({ profileScriptPath: path.resolve("scripts/grok-bot-native-profile.ps1") }), path.resolve("scripts/grok-bot-native-profile.ps1"));
    assert.throws(() => grokBotProfileScriptPath({ profileScriptPath: path.join(directory, "missing.ps1") }), /GROK_BOT_PROFILE_HELPER_UNAVAILABLE/);
  } finally {
    if (previous === undefined) delete process.env.RABIROUTE_PACKAGE_ROOT; else process.env.RABIROUTE_PACKAGE_ROOT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("profile deadline failure has a closed timeout code distinct from signed-out state", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot-timeout-fixture-"));
  try {
    const script = path.join(directory, "slow-profile.ps1");
    await fs.writeFile(script, "param([string]$ProfilePath,[switch]$CredentialForClient)\nStart-Sleep -Seconds 10\n");
    for (const name of ["desktop-status.json", "sand-secrets.json", "Local State"]) await fs.writeFile(path.join(directory, name), JSON.stringify({ pid: process.pid }));
    await assert.rejects(readGrokBotNativeProfile({ profileScriptPath: script, profilePath: directory, timeoutMs: 1_000 }), /GROK_BOT_PROFILE_TIMEOUT/);
    assert.throws(() => new GrokBotClient({ timeoutMs: 999 }), /GROK_BOT_TIMEOUT_INVALID/);
    assert.throws(() => new GrokBotClient({ timeoutMs: 60_001 }), /GROK_BOT_TIMEOUT_INVALID/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
async function profileCacheFixture(t: import("node:test").TestContext) {
  const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot-cache-fixture-"));
  t.after(() => fs.rm(profilePath, { recursive: true, force: true }));
  for (const name of ["desktop-status.json", "sand-secrets.json", "Local State"]) await fs.writeFile(path.join(profilePath, name), JSON.stringify({ fixture: name, pid: process.pid }));
  return { profilePath, profileScriptPath: path.resolve("scripts/grok-bot-native-profile.ps1") };
}
test("protected disk cache coalesces one helper and invalidates changed files without mixing account scopes", { skip: process.platform !== "win32" }, async t => {
  const options = await profileCacheFixture(t);
  let calls = 0;
  let current = snapshot(Date.now(), 3_600);
  const runProfileHelper = async () => { calls += 1; return current.profile; };
  const reads = { ...options, runProfileHelper };
  const first = await Promise.all([readGrokBotNativeProfile(reads), readGrokBotNativeProfile(reads)]);
  assert.equal(calls, 1);
  assert.equal(first[0].accessToken, current.token);
  first[0].accessToken = "mutated caller copy";
  assert.equal((await readGrokBotNativeProfile(reads)).accessToken, current.token);
  assert.equal(calls, 1);
  current = snapshot(Date.now(), 3_600, "fixture-user-2");
  await fs.writeFile(path.join(options.profilePath, "sand-secrets.json"), "changed protected fixture");
  assert.equal((await readGrokBotNativeProfile(reads)).accessToken, current.token);
  assert.notEqual(first[0].accountScope, current.profile.accountScope);
  assert.equal(calls, 2);
});
test("profile files changing during a shared helper fail closed and never publish a mixed-scope credential", { skip: process.platform !== "win32" }, async t => {
  const options = await profileCacheFixture(t);
  let started!: () => void, release!: () => void, calls = 0;
  const helperStarted = new Promise<void>(done => { started = done; });
  const pending = new Promise<void>(done => { release = done; });
  const fixture = snapshot(Date.now(), 3_600);
  const reads = { ...options, runProfileHelper: async () => { calls += 1; started(); await pending; return fixture.profile; } };
  const first = readGrokBotNativeProfile(reads);
  await helperStarted;
  const second = readGrokBotNativeProfile(reads);
  await fs.writeFile(path.join(options.profilePath, "sand-secrets.json"), "new protected fixture scope");
  release();
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === "rejected" && result.reason instanceof GrokBotError && result.reason.code === "GROK_BOT_ACCOUNT_CHANGED"));
  assert.equal(calls, 1);
  assert.equal((await readGrokBotNativeProfile(reads)).accessToken, fixture.token);
  assert.equal(calls, 2);
});
test("expired cached JWT is never reused and the credential cache holds at most four profiles", { skip: process.platform !== "win32" }, async t => {
  const options = await profileCacheFixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const fixture = snapshot(now, 60);
  let calls = 0;
  const reads = { ...options, runProfileHelper: async () => { calls += 1; return fixture.profile; } };
  await readGrokBotNativeProfile(reads); await readGrokBotNativeProfile(reads);
  assert.equal(calls, 1);
  now += 61_000;
  await assert.rejects(readGrokBotNativeProfile(reads), /GROK_BOT_TOKEN_EXPIRED/);
  assert.equal(calls, 2);
  const live = snapshot(now, 3_600);
  const runProfileHelper = async () => { calls += 1; return live.profile; };
  const profiles = [];
  for (let index = 0; index < 5; index++) {
    const profile = await profileCacheFixture(t); profiles.push(profile);
    await readGrokBotNativeProfile({ ...profile, runProfileHelper });
  }
  assert.equal(calls, 7);
  await readGrokBotNativeProfile({ ...profiles[0], runProfileHelper });
  assert.equal(calls, 8);
});
test("trusted readProfile injection remains uncached between owner checks", async () => {
  let reads = 0;
  const client = new GrokBotClient({ readProfile: async () => { reads += 1; return credentials(); } });
  await client.profileStatus(); await client.profileStatus();
  assert.equal(reads, 2);
});
test("disk profile credentials cannot be read or forwarded to an unverified backend origin", () => {
  let requests = 0;
  for (const backendUrl of ["https://unverified.invalid/", "https://api2.cursor.sh.unverified.invalid/", "http://api2.cursor.sh/", "https://api2.cursor.sh:444/"]) {
    assert.throws(() => new GrokBotClient({ backendUrl, profileScriptPath: "fixture-script-must-not-run", request: async () => {
      requests += 1; return Response.json({});
    } }), /GROK_BOT_BACKEND_MISMATCH/);
  }
  assert.equal(requests, 0);
});
test("native RPC keeps the exact service path when an allowed origin has a configured base path", async () => {
  let requested = "";
  const client = new GrokBotClient({ backendUrl: "https://api2.cursor.sh/path-proxy/", readProfile: async () => credentials(),
    request: async (input, init) => { requested = String(input); assert.equal(init?.redirect, "error"); return Response.json({ agents: [] }); } });
  await client.listBots();
  assert.equal(requested, "https://api2.cursor.sh/aiserver.v1.GrokBotService/ListGrokBotAgents");
});
test("native redirect never reaches the redirected owner or forwards a credential", async t => {
  let destinationRequests = 0;
  const destination = createServer((_request, response) => { destinationRequests += 1; response.end("{}"); });
  await new Promise<void>(resolve => destination.listen(0, "127.0.0.1", resolve));
  const destinationUrl = "http://127.0.0.1:" + (destination.address() as AddressInfo).port + "/fixture";
  const source = createServer((_request, response) => { response.writeHead(302, { location: destinationUrl }); response.end(); });
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await Promise.all([new Promise<void>(resolve => source.close(() => resolve())), new Promise<void>(resolve => destination.close(() => resolve()))]); });
  const client = new GrokBotClient({ backendUrl: "http://127.0.0.1:" + (source.address() as AddressInfo).port,
    readProfile: async () => credentials(), timeoutMs: 2_000 });
  await assert.rejects(client.listBots(), /GROK_BOT_TRANSPORT_UNAVAILABLE/);
  assert.equal(destinationRequests, 0);
});
test("native roster uses agentId, bounded transcript request and original owner session", async () => {
  const { client, calls } = fixtureClient((method, _body, headers) => {
    assert.equal(headers.get("authorization"), "Bearer fixture-token");
    assert.equal(headers.get("connect-protocol-version"), "1");
    if (method === "ListGrokBotAgents") return { agents: [{ id: "legacy-id", agentId: session.agentId, name: "Fixture Bot" }], truncated: true };
    if (method === "ListGrokBotAgentSessions") return { sessions: [session] };
    return { entries: [{ id: "row-1" }], generation: 2 };
  });
  assert.equal((await client.listBots()).bots[0].agentId, session.agentId);
  assert.deepEqual(await client.listSessions(session.agentId), [{ ...session, kind: undefined, createdAtMs: undefined, lastActivityAtMs: undefined }]);
  assert.equal((await client.readTranscript(session.agentId, session.sessionId, { limit: 999, beforeSeq: "2" })).entries.length, 1);
  assert.deepEqual(calls.at(-1)?.body, { agentId: session.agentId, sessionId: session.sessionId, limit: 500, beforeSeq: "2" });
});
test("cross-owner session response fails closed before a prompt is sent", async () => {
  const { client, calls } = fixtureClient(() => ({ sessions: [{ ...session, agentId: "another-owner" }] }));
  await assert.rejects(client.sendNative(send), /GROK_BOT_SESSION_OWNER_MISMATCH/);
  assert.equal(calls.some(call => call.method === "SendGrokBotUserMessage"), false);
});
test("same real session receives separate message IDs and duplicate native receipt is explicit", async () => {
  let delivered = 0;
  const { client, calls } = fixtureClient(method => method === "ListGrokBotAgentSessions" ? { sessions: [session] } : { delivery: ++delivered === 1 ? "ACCEPTED_TEMPORAL" : "DUPLICATE" });
  const first = await client.sendNative(send);
  const second = await client.sendNative({ ...send, messageId: "delivery-fixture-2" });
  assert.equal(first.accepted, true);
  assert.equal(second.duplicate, true);
  assert.deepEqual(calls.filter(call => call.method === "SendGrokBotUserMessage").map(call => call.body.sessionId), [session.sessionId, session.sessionId]);
});
test("lost response queries original messageId and never repeats native send", async () => {
  const { client, calls } = fixtureClient(method => {
    if (method === "ListGrokBotAgentSessions") return { sessions: [session] };
    if (method === "SendGrokBotUserMessage") throw new Error("fixture-token transport failure");
    return { status: "ACCEPTED", echoEntryId: "entry-fixture" };
  });
  const receipt = await client.sendNative(send);
  assert.equal(receipt.recovered, true);
  assert.equal(receipt.echoEntryId, "entry-fixture");
  assert.equal(calls.filter(call => call.method === "SendGrokBotUserMessage").length, 1);
  assert.deepEqual(calls.at(-1)?.body, { agentId: session.agentId, sessionId: session.sessionId, messageId: send.messageId });
});
test("unknown receipt remains uncertain and raw transport/server bodies never escape", async () => {
  const { client, calls } = fixtureClient(method => {
    if (method === "ListGrokBotAgentSessions") return { sessions: [session] };
    if (method === "SendGrokBotUserMessage") return new Response("fixture-token", { status: 503 });
    return { status: "UNKNOWN_DURABILITY" };
  });
  await assert.rejects(client.sendNative(send), (error: unknown) => error instanceof GrokBotError && error.uncertain && !String(error).includes("fixture-token"));
  assert.equal(calls.filter(call => call.method === "SendGrokBotUserMessage").length, 1);
});
test("refused native delivery fails without receipt query or fallback", async () => {
  const { client, calls } = fixtureClient(method => method === "ListGrokBotAgentSessions" ? { sessions: [session] } : { delivery: "REFUSED", refusal: { message: "fixture-token" } });
  await assert.rejects(client.sendNative(send), /GROK_BOT_DELIVERY_REJECTED/);
  assert.equal(calls.some(call => call.method === "GetGrokBotSendStatus"), false);
});
test("account switch after owner acceptance produces uncertain result", async () => {
  let switched = false;
  const client = new GrokBotClient({ backendUrl: "http://127.0.0.1:30001/", readProfile: async () => ({ ...credentials(), accountScope: switched ? "changed" : "original" }),
    request: async input => {
      const method = String(input).split("/").at(-1);
      if (method === "ListGrokBotAgentSessions") return Response.json({ sessions: [session] });
      if (method === "ListGrokBotAgents") return Response.json({ agents: [{ agentId: session.agentId, name: "Fixture Bot", harness: "box" }] });
      switched = true;
      return Response.json({ delivery: "ACCEPTED_TEMPORAL" });
    } });
  await assert.rejects(client.sendNative(send), (error: unknown) => error instanceof GrokBotError && error.uncertain);
});
test("profile read failure after owner acceptance remains uncertain and cannot trigger another send", async () => {
  let ownerAccepted = false;
  const calls: string[] = [];
  const client = new GrokBotClient({ readProfile: async () => {
    if (ownerAccepted) throw new Error("fixture private credential reader error");
    return credentials();
  }, request: async input => {
    const method = String(input).split("/").at(-1)!; calls.push(method);
    if (method === "ListGrokBotAgentSessions") return Response.json({ sessions: [session] });
    if (method === "ListGrokBotAgents") return Response.json({ agents: [{ agentId: session.agentId, name: "Fixture Bot", harness: "box" }] });
    ownerAccepted = true;
    return Response.json({ delivery: "ACCEPTED_TEMPORAL" });
  } });
  await assert.rejects(client.sendNative(send), (error: unknown) => error instanceof GrokBotError && error.uncertain && error.code === "GROK_BOT_DELIVERY_UNCONFIRMED");
  assert.equal(calls.filter(method => method === "SendGrokBotUserMessage").length, 1);
});
test("proof scope mismatch fails before session lookup or native send", async () => {
  const { client, calls } = fixtureClient(() => ({ delivery: "ACCEPTED_TEMPORAL" }));
  await assert.rejects(client.sendNative(send, "previous-account"), /GROK_BOT_ACCOUNT_CHANGED/);
  assert.equal(calls.length, 0);
});
test("account switch between session verification and send never uses the new account", async () => {
  let switched = false;
  const calls: string[] = [];
  const client = new GrokBotClient({ readProfile: async () => ({ ...credentials(), accountScope: switched ? "changed" : "original" }),
    request: async input => {
      calls.push(String(input).split("/").at(-1)!);
      switched = true;
      return Response.json({ agents: [{ agentId: session.agentId, name: "Fixture Bot" }] });
    } });
  await assert.rejects(client.sendNative(send, "original"), /GROK_BOT_ACCOUNT_CHANGED/);
  assert.deepEqual(calls, ["ListGrokBotAgents"]);
});

const roomRoster = [{ agentId: "fixture-room", name: "Fixture Room", kind: "GROK_BOT_AGENT_KIND_ROOM", memberAgentIds: ["fixture-sender"] },
  { agentId: "fixture-sender", name: "Fixture Sender", kind: "AGENT" }, { agentId: "fixture-other", name: "Other", kind: 1 }];
const roomSend = { agentId: "fixture-room", sessionId: "", defaultMain: true as const, messageId: "fixture-room-message", text: "One line." };
const roomAliasSend = { agentId: "fixture-sender", sessionId: "fixture-room", fromAgentId: "fixture-sender",
  deliveryType: "group" as const, messageId: "fixture-alias-message", text: "Alias group message." };

test("sender/group roster-backed address sends only to the room and retains original journal tuple", async () => {
  const { client, calls } = fixtureClient(method => {
    if (method === "ListGrokBotAgents") return { agents: roomRoster };
    assert.equal(method, "SendGrokBotAgentMessage");
    return { delivery: "GROK_BOT_AGENT_MESSAGE_DELIVERY_DELIVERED_BOX", targetAgentId: "fixture-room", targetName: "Fixture Room" };
  });
  const receipt = await client.sendNative(roomAliasSend);
  assert.equal(receipt.agentId, roomAliasSend.agentId);
  assert.equal(receipt.sessionId, roomAliasSend.sessionId);
  assert.equal(receipt.targetAgentId, "fixture-room");
  const sent = calls.at(-1)!;
  assert.equal(sent.body.toAgentId, "fixture-room");
  assert.equal(sent.body.fromAgentId, "fixture-sender");
  assert.equal(calls.some(call => call.method === "SendGrokBotUserMessage" || call.method === "ListGrokBotAgentSessions"), false);
});

test("sender/group address rejects missing room, nonmember and mismatched explicit identity before send", async () => {
  for (const input of [{ ...roomAliasSend, sessionId: "missing" }, { ...roomAliasSend, sessionId: "fixture-other" },
    { ...roomAliasSend, agentId: "fixture-other", fromAgentId: "fixture-other" }, { ...roomAliasSend, fromAgentId: "fixture-other" },
    { ...roomAliasSend, agentId: "fixture-other", fromAgentId: undefined }]) {
    const { client, calls } = fixtureClient(() => ({ agents: roomRoster }));
    await assert.rejects(client.sendNative(input), GrokBotError);
    assert.equal(calls.some(call => call.method.startsWith("Send")), false);
  }
});

test("sender/group alias without identity sends directly to the room and preserves the saved tuple", async () => {
  const input = { ...roomAliasSend, fromAgentId: undefined };
  const { client, calls } = fixtureClient(method => {
    if (method === "ListGrokBotAgents") return { agents: roomRoster };
    assert.equal(method, "SendGrokBotUserMessage");
    return { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_BOX" };
  });
  const receipt = await client.sendNative(input);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.agentId, input.agentId);
  assert.equal(receipt.sessionId, input.sessionId);
  assert.equal(receipt.messageId, input.messageId);
  assert.equal(input.sessionId, "fixture-room");
  assert.equal("defaultMain" in input, false);
  const sends = calls.filter(call => call.method.startsWith("Send"));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].method, "SendGrokBotUserMessage");
  assert.equal(sends[0].body.agentId, "fixture-room");
  assert.equal(sends[0].body.sessionId, "");
  assert.equal(sends[0].body.text, input.text);
  assert.equal("fromAgentId" in sends[0].body, false);
  assert.equal(calls.some(call => call.method === "ListGrokBotAgentSessions"), false);
});

test("direct sender/group alias refusal and timeout never fall back to sender private or another send", async () => {
  for (const outcome of ["refused", "recovered", "unknown"]) {
    const { client, calls } = fixtureClient(method => {
      if (method === "ListGrokBotAgents") return { agents: roomRoster };
      if (method === "SendGrokBotUserMessage") {
        if (outcome === "refused") return { delivery: "REFUSED" };
        throw new DOMException("Fixture timeout", "TimeoutError");
      }
      assert.equal(method, "GetGrokBotSendStatus");
      return { status: outcome === "recovered" ? "ACCEPTED" : "UNKNOWN_DURABILITY" };
    });
    const input = { ...roomAliasSend, fromAgentId: undefined };
    if (outcome === "recovered") {
      const receipt = await client.sendNative(input);
      assert.equal(receipt.recovered, true);
      assert.equal(receipt.agentId, input.agentId);
      assert.equal(receipt.sessionId, input.sessionId);
    } else {
      await assert.rejects(client.sendNative(input), (error: unknown) => error instanceof GrokBotError
        && error.code === (outcome === "refused" ? "GROK_BOT_DELIVERY_REJECTED" : "GROK_BOT_DELIVERY_UNCONFIRMED"));
    }
    const sends = calls.filter(call => call.method.startsWith("Send"));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].method, "SendGrokBotUserMessage");
    assert.equal(sends[0].body.agentId, "fixture-room");
    assert.equal(sends[0].body.sessionId, "");
    if (outcome !== "refused") assert.deepEqual(calls.at(-1), { method: "GetGrokBotSendStatus",
      body: { agentId: "fixture-room", sessionId: "", messageId: input.messageId } });
  }
});

test("sender/group native refusal, wrong receipt and timeout never send to sender or fall back", async () => {
  for (const response of [{ delivery: "FORBIDDEN" }, { delivery: "DELIVERED_BOX", targetAgentId: "fixture-sender" }, "timeout"]) {
    const { client, calls } = fixtureClient(method => {
      if (method === "ListGrokBotAgents") return { agents: roomRoster };
      if (response === "timeout") throw new DOMException("Fixture timeout", "TimeoutError");
      return response;
    });
    await assert.rejects(client.sendNative(roomAliasSend), GrokBotError);
    const sends = calls.filter(call => call.method.startsWith("Send"));
    assert.equal(sends.length, 1);
    assert.equal(sends[0].method, "SendGrokBotAgentMessage");
    assert.equal(sends[0].body.toAgentId, "fixture-room");
  }
});

test("sender/group status resolves the original message to the room main without any send", async () => {
  for (const status of ["ACCEPTED", "REJECTED", "PENDING", "UNKNOWN_DURABILITY"]) {
    const { client, calls } = fixtureClient(method => method === "ListGrokBotAgents" ? { agents: roomRoster } : { status });
    const receipt = await client.getSendStatus(roomAliasSend.agentId, roomAliasSend.sessionId, roomAliasSend.messageId);
    assert.equal(receipt.status, status.toLowerCase().replaceAll("_", "-"));
    assert.deepEqual(calls.at(-1), { method: "GetGrokBotSendStatus", body: { agentId: "fixture-room", sessionId: "", messageId: roomAliasSend.messageId } });
    assert.equal(calls.some(call => call.method.startsWith("Send")), false);
  }
  const denied = fixtureClient(() => ({ agents: roomRoster }));
  await assert.rejects(denied.client.getSendStatus("fixture-other", "fixture-room", "original-message"), /GROK_BOT_SENDER_NOT_MEMBER/);
  assert.equal(denied.calls.some(call => call.method === "GetGrokBotSendStatus"), false);
});

test("room roster retains native metadata and exposes only a roster-backed default-main address", async () => {
  const { client, calls } = fixtureClient(method => {
    assert.equal(method, "ListGrokBotAgents");
    return { agents: roomRoster };
  });
  assert.deepEqual((await client.listBots()).bots[0].memberAgentIds, ["fixture-sender"]);
  assert.equal((await client.listBots()).bots[0].kind, "GROK_BOT_AGENT_KIND_ROOM");
  assert.deepEqual(await client.listSessions("fixture-room"), [{ agentId: "fixture-room", sessionId: "", defaultMain: true, kind: "MAIN" }]);
  assert.equal(calls.every(call => call.method === "ListGrokBotAgents"), true);
  await assert.rejects(client.listSessions("missing-room"), /GROK_BOT_SESSION_NOT_FOUND/);
});

test("native room direct and identity sends target the room without private relay", async () => {
  const { client, calls } = fixtureClient(method => method === "ListGrokBotAgents" ? { agents: roomRoster }
    : method === "SendGrokBotUserMessage" ? { delivery: "GROK_BOT_USER_MESSAGE_DELIVERY_ACCEPTED_TEMPORAL" }
    : { delivery: "GROK_BOT_AGENT_MESSAGE_DELIVERY_DELIVERED_TEMPORAL", targetAgentId: "fixture-room", targetName: "Fixture Room", workflowId: "fixture-workflow" });
  assert.equal((await client.sendNative({ ...roomSend, deliveryType: "group" })).accepted, true);
  assert.equal((await client.sendNative({ ...roomSend, messageId: "second", fromAgentId: "fixture-sender", replyToId: "original" })).workflowId, "fixture-workflow");
  const sends = calls.filter(call => call.method === "SendGrokBotAgentMessage");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.toAgentId, "fixture-room");
  assert.equal(sends[0].body.fromAgentId, "fixture-sender");
  assert.equal("sessionId" in sends[0].body, false);
  assert.equal(sends[0].body.replyToId, "original");
  const direct = calls.filter(call => call.method === "SendGrokBotUserMessage");
  assert.equal(direct.length, 1);
  assert.equal(direct[0].body.agentId, "fixture-room");
  assert.equal(direct[0].body.sessionId, "");
  assert.equal(direct[0].body.messageId, roomSend.messageId);
  assert.equal(direct[0].body.text, roomSend.text);
  assert.equal("fromAgentId" in direct[0].body, false);
  assert.equal("toAgentId" in direct[0].body, false);
  assert.equal(calls.some(call => call.method === "ListGrokBotAgentSessions"), false);
});

test("direct room refusal and unknown delivery never fall back or send twice", async () => {
  for (const delivery of ["GROK_BOT_USER_MESSAGE_DELIVERY_REFUSED", "UNSPECIFIED"]) {
    const { client, calls } = fixtureClient(method => method === "ListGrokBotAgents" ? { agents: roomRoster } : { delivery });
    await assert.rejects(client.sendNative({ ...roomSend, deliveryType: "group" }), (error: unknown) => error instanceof GrokBotError
      && error.code === (delivery.endsWith("REFUSED") ? "GROK_BOT_DELIVERY_REJECTED" : "GROK_BOT_DELIVERY_UNCONFIRMED")
      && error.uncertain === !delivery.endsWith("REFUSED"));
    assert.equal(calls.filter(call => call.method === "SendGrokBotUserMessage").length, 1);
    assert.equal(calls.some(call => call.method === "SendGrokBotAgentMessage" || call.method === "GetGrokBotSendStatus"), false);
  }
});

test("direct room timeout reads original room/message status without resend or identity fallback", async () => {
  for (const status of ["ACCEPTED", "REJECTED", "UNKNOWN_DURABILITY", "unavailable"]) {
    const { client, calls } = fixtureClient(method => {
      if (method === "ListGrokBotAgents") return { agents: roomRoster };
      if (method === "SendGrokBotUserMessage") throw new DOMException("Fixture timeout", "TimeoutError");
      assert.equal(method, "GetGrokBotSendStatus");
      if (status === "unavailable") throw new Error("Fixture status unavailable");
      return { status, echoEntryId: "fixture-room-echo" };
    });
    if (status === "ACCEPTED") {
      const receipt = await client.sendNative(roomSend);
      assert.equal(receipt.recovered, true);
      assert.equal(receipt.agentId, roomSend.agentId);
      assert.equal(receipt.sessionId, "");
      assert.equal(receipt.echoEntryId, "fixture-room-echo");
    } else {
      await assert.rejects(client.sendNative(roomSend), (error: unknown) => error instanceof GrokBotError
        && error.code === (status === "REJECTED" ? "GROK_BOT_DELIVERY_REJECTED" : "GROK_BOT_DELIVERY_UNCONFIRMED")
        && error.uncertain === (status !== "REJECTED"));
    }
    assert.equal(calls.filter(call => call.method === "SendGrokBotUserMessage").length, 1);
    assert.equal(calls.some(call => call.method === "SendGrokBotAgentMessage"), false);
    assert.deepEqual(calls.at(-1), { method: "GetGrokBotSendStatus", body: { agentId: roomSend.agentId, sessionId: "", messageId: roomSend.messageId } });
  }
});

test("native sender must be a real agent and a member of a room; kind and session mismatches fail closed", async () => {
  const { client, calls } = fixtureClient(() => ({ agents: roomRoster }));
  for (const sender of ["missing", "fixture-room"]) await assert.rejects(client.sendNative({ ...roomSend, fromAgentId: sender }), /GROK_BOT_SENDER_NOT_FOUND/);
  await assert.rejects(client.sendNative({ ...roomSend, fromAgentId: "fixture-other" }), /GROK_BOT_SENDER_NOT_MEMBER/);
  await assert.rejects(client.sendNative({ ...roomSend, deliveryType: "private" }), /GROK_BOT_TARGET_KIND_MISMATCH/);
  await assert.rejects(client.sendNative({ ...roomSend, sessionId: "unrelated", defaultMain: undefined, fromAgentId: "fixture-sender" }), /GROK_BOT_NATIVE_TARGET_REQUIRES_MAIN/);
  await assert.rejects(client.sendNative({ ...roomSend, sessionId: "unrelated", defaultMain: undefined }), /GROK_BOT_SESSION_NOT_FOUND/);
  assert.equal(calls.some(call => call.method.startsWith("Send")), false);
});

test("native agent delivery validates target receipts and never retries or falls back on refusal or uncertainty", async () => {
  for (const response of [{ delivery: "GROK_BOT_AGENT_MESSAGE_DELIVERY_FORBIDDEN" }, { delivery: "DELIVERED_BOX", targetAgentId: "other" }, { delivery: "UNSPECIFIED" }, new Response("private", { status: 503 })]) {
    const { client, calls } = fixtureClient(method => method === "ListGrokBotAgents" ? { agents: roomRoster } : response);
    await assert.rejects(client.sendNative({ ...roomSend, fromAgentId: "fixture-sender" }), GrokBotError);
    assert.equal(calls.filter(call => call.method === "SendGrokBotAgentMessage").length, 1);
    assert.equal(calls.some(call => call.method === "SendGrokBotUserMessage"), false);
  }
});

test("explicit native identity can target a private bot main without adding identity to SendUserMessage", async () => {
  const { client, calls } = fixtureClient(method => method === "ListGrokBotAgents" ? { agents: roomRoster }
    : { delivery: 3, targetAgentId: "fixture-other", targetName: "Other" });
  const receipt = await client.sendNative({ ...roomSend, agentId: "fixture-other", fromAgentId: "fixture-sender", deliveryType: "private" });
  assert.equal(receipt.duplicate, true);
  assert.equal(calls.at(-1)?.method, "SendGrokBotAgentMessage");
  assert.equal(calls.at(-1)?.body.toAgentId, "fixture-other");
});
function snapshot(nowMs: number, expiresInSeconds = 60, subject = "fixture-user"): { profile: GrokBotProfileSnapshot; token: string } {
  const payload = { sub: subject, exp: Math.floor(nowMs / 1000) + expiresInSeconds };
  const token = "fixture." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".fixture";
  const key = randomBytes(32), nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const blob = Buffer.concat([Buffer.from("v10"), nonce, cipher.update(token, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { token, profile: { version: 1, signedIn: true, accountScope: createHash("sha256").update(payload.sub).digest("hex"),
    encryptionKey: key.toString("base64"), accessToken: { format: "aes-gcm", data: blob.toString("base64") } } };
}
test("protected profile decrypts valid AES-GCM and verifies current slot, integrity and expiry", () => {
  const now = 1_800_000_000_000;
  const fixture = snapshot(now);
  assert.equal(decodeGrokBotProfileSnapshot(fixture.profile, now).accessToken, fixture.token);
  assert.throws(() => decodeGrokBotProfileSnapshot({ ...fixture.profile, accountScope: "wrong" }, now), /GROK_BOT_ACCOUNT_MISMATCH/);
  assert.throws(() => decodeGrokBotProfileSnapshot(fixture.profile, now + 120_000), /GROK_BOT_TOKEN_EXPIRED/);
  const damaged = Buffer.from(fixture.profile.accessToken!.data, "base64");
  damaged[damaged.length - 1] ^= 1;
  assert.throws(() => decodeGrokBotProfileSnapshot({ ...fixture.profile, accessToken: { format: "aes-gcm", data: damaged.toString("base64") } }, now), /GROK_BOT_CREDENTIAL_UNREADABLE/);
});
test("Windows profile bridge decrypts only the active slot and leaves every profile file unchanged", { skip: process.platform !== "win32" }, async () => {
  const execFileAsync = promisify(execFile);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grokbot-profile-fixture-"));
  const fixture = snapshot(Date.now(), 3_600);
  const key = fixture.profile.encryptionKey!;
  const protect = "Add-Type -AssemblyName System.Security; [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String('" + key + "'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";
  try {
    const protectedKey = (await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", protect], { windowsHide: true })).stdout;
    const files = new Map<string, string>([
      ["desktop-status.json", JSON.stringify({ signedIn: true, pid: process.pid, appVersion: "0.70.2" })],
      ["sand-secrets.json", JSON.stringify({ version: 1, "cursor-accounts": JSON.stringify({ active: fixture.profile.accountScope,
        accounts: { [fixture.profile.accountScope!]: { "cursor-access-token": fixture.profile.accessToken!.data },
          "inactive-fixture": { "cursor-access-token": "inactive protected fixture" } } }) })],
      ["Local State", JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), Buffer.from(protectedKey, "base64")]).toString("base64") } })]
    ]);
    for (const [name, content] of files) await fs.writeFile(path.join(directory, name), content);
    const script = path.resolve("scripts/grok-bot-native-profile.ps1");
    const metadata = JSON.parse((await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-ProfilePath", directory], { windowsHide: true })).stdout);
    assert.equal(metadata.accountScope, fixture.profile.accountScope);
    assert.equal("accessToken" in metadata, false);
    assert.equal("encryptionKey" in metadata, false);
    assert.equal((await readGrokBotNativeProfile({ profilePath: directory, profileScriptPath: script, timeoutMs: 60_000 })).accessToken, fixture.token);
    for (const [name, content] of files) assert.equal(await fs.readFile(path.join(directory, name), "utf8"), content);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});


test("a stopped desktop cannot reuse protected credentials or contact the cloud", { skip: process.platform !== "win32" }, async t => {
  const options = await profileCacheFixture(t);
  const fixture = snapshot(Date.now(), 3_600);
  let reads = 0;
  const input = { ...options, runProfileHelper: async () => { reads += 1; return fixture.profile; } };
  await readGrokBotNativeProfile(input);
  await fs.writeFile(path.join(options.profilePath, "desktop-status.json"), JSON.stringify({ pid: 2147483647, signedIn: true }));
  const before = await fs.readFile(path.join(options.profilePath, "sand-secrets.json"), "utf8");
  await assert.rejects(readGrokBotNativeProfile(input), /GROK_BOT_NOT_RUNNING/);
  assert.equal(reads, 1);
  assert.equal(await fs.readFile(path.join(options.profilePath, "sand-secrets.json"), "utf8"), before);
});

test("HTTP failures carry status and method without secrets and treat 429 as retryable", async () => {
  const limited = fixtureClient(() => new Response("private server response", { status: 429 }));
  const error = await limited.client.listSessions(session.agentId).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof GrokBotError);
  assert.equal(error.code, "GROK_BOT_HTTP_FAILED:429");
  assert.equal(error.httpStatus, 429);
  assert.equal(error.retryable, true);
  assert.equal(error.uncertain, true);
  assert.match(error.message, /^GROK_BOT_HTTP_FAILED:429 \(ListGrokBot/);
  assert.doesNotMatch(error.message, /fixture-token|private server response/);
  const bad = fixtureClient(() => new Response("{}", { status: 400 }));
  const rejected = await bad.client.listSessions(session.agentId).then(() => undefined, (caught: unknown) => caught);
  assert.ok(rejected instanceof GrokBotError);
  assert.equal(rejected.code, "GROK_BOT_HTTP_FAILED:400");
  assert.equal(rejected.retryable, false);
});
