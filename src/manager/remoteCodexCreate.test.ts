import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRemoteCodexAndDeliver } from "./remoteCodexCreate.js";
import { CodexMetadataNotStartedError, readCallerCodexCreation } from "../codexThreadCreationReservations.js";

function fixture(t: import("node:test").TestContext) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-create-preflight-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const session = "019f0000-0000-7000-8000-000000000003";
  const source: any = { threadId: session, agentAdapter: "codex", agentType: "agent", workspace: rootDir,
    endpoint: { kind: "local", managerInstanceId: "fixture-manager", agentId: "local:codex", provider: "codex", sessionId: session, authorizationIncarnation: "epoch" } };
  const f: any = { rootDir, source, nativeCreates: 0, sends: 0, statusCalls: 0, authorized: true, remoteState: "absent" };
  f.request = { action: "create", agentAdapter: "codex", title: "Original title", cwd: rootDir,
    prompt: "Original initial message", deliveryId: "original-caller", responsePolicy: "none",
    sourceThreadId: session, sourceAgentType: "agent", messageSource: { type: "agent", agentAdapter: "codex", sessionId: session, sessionName: "Source" },
    instanceBinding: { instanceId: "original-computer", agentId: "original-agent" } };
  f.options = {
    rootDir,
    endpoint: { resolveSource: () => source, authorize: () => { if (!f.authorized) throw Error("authority revoked"); } },
    metadataStatus: async (_binding: any, key: string) => {
      f.statusCalls++; f.key = key; await f.statusGate;
      if (f.statusError) throw Error("SDK Unsupported action");
      if (f.onStatus) f.onStatus();
      return { protocolVersion: 1, callerKey: key, state: f.remoteState,
        ...(f.remoteState !== "absent" ? { intentHash: f.remoteHash ?? "0".repeat(64) } : {}), ...(f.remoteResult ?? {}) };
    },
    createMetadata: async (request: any) => {
      if (f.metadataNotStarted) throw new CodexMetadataNotStartedError("Fixture no metadata effect");
      f.nativeCreates++; await f.metadataGate;
      if (f.metadataError) throw Error("Metadata acknowledgement lost");
      const id = "019f0000-0000-7000-8000-000000000201";
      return { protocolVersion: 1, callerKey: request.creationIntent.callerKey, intentHash: request.creationIntent.intentHash, state: "completed", threadId: id,
        thread: { id, title: request.title, cwd: rootDir, updatedAt: "2026-11-04T00:00:00Z", source: "synthetic", initialTurnStatus: "not-requested" } };
    },
    sendPrepared: async (request: any) => { f.sends++; f.sent = request; return { statusCode: 200, data: { status: "delivered" } }; }
  };
  f.call = (request = f.request) => createRemoteCodexAndDeliver({ ...f.options, request });
  f.record = () => readCallerCodexCreation(rootDir, f.key);
  f.file = () => { const files = fs.readdirSync(rootDir, { recursive: true }) as string[]; return path.join(rootDir, files.find(p => String(p).includes("codex-thread-creations") && String(p).endsWith(".json"))!); };
  return f;
}

test("unsupported read-only preflight leaves a new caller unused for a later clarified original request", async t => {
  const f = fixture(t); f.statusError = true;
  await assert.rejects(f.call(), /Unsupported/);
  assert.equal(f.record(), null); assert.equal(f.nativeCreates, 0); assert.equal(f.sends, 0);
  f.statusError = false;
  await f.call({ ...f.request, title: "Clarified title", prompt: "Clarified initial message" });
  assert.equal(f.nativeCreates, 1); assert.equal(f.sends, 1);
  assert.equal(f.sent.deliveryId, f.request.deliveryId); assert.equal(f.sent.prompt, "Clarified initial message");
  assert.equal(f.record().state, "completed");
});

for (const mode of ["status-unknown", "remote-conflict", "revoked"]) test(`first preflight ${mode} never creates or sends`, async t => {
  const f = fixture(t);
  if (mode === "status-unknown") f.statusError = true;
  if (mode === "remote-conflict") { f.remoteState = "completed"; f.remoteHash = "a".repeat(64); }
  if (mode === "revoked") f.onStatus = () => { f.authorized = false; };
  await assert.rejects(f.call());
  assert.equal(f.nativeCreates, 0); assert.equal(f.sends, 0); assert.equal(f.record(), null);
});

test("legacy failed-before-create keeps the exact frozen hash and recovers only its original body", async t => {
  const f = fixture(t);
  // Reuse the original reservation owner's proven-before-create error to model its legacy failed row.
  f.metadataNotStarted = true;
  await assert.rejects(f.call(), CodexMetadataNotStartedError);
  f.metadataNotStarted = false;
  const before = f.record(); assert.equal(before.state, "failed_before_create");
  const bytes = fs.readFileSync(f.file()); f.statusError = false;
  await assert.rejects(f.call({ ...f.request, prompt: "Clarified later message" }), /frozen/);
  assert.deepEqual(fs.readFileSync(f.file()), bytes); assert.equal(f.nativeCreates, 0); assert.equal(f.sends, 0);
  await f.call();
  assert.equal(f.record().key, before.key); assert.equal(f.record().createdAt, before.createdAt);
  assert.equal(f.record().callerIntentHash, before.callerIntentHash); assert.equal(f.nativeCreates, 1); assert.equal(f.sends, 1);
});

test("unknown metadata effects retain original immutable intent without a second native create", async t => {
  const f = fixture(t); f.metadataError = true;
  await assert.rejects(f.call(), /uncertain/);
  const before = fs.readFileSync(f.file());
  await assert.rejects(f.call({ ...f.request, prompt: "Replacement initial message" }), /frozen/);
  assert.deepEqual(fs.readFileSync(f.file()), before); assert.equal(f.nativeCreates, 1); assert.equal(f.sends, 0);
});

test("preflight preserves one native creation when callers race on the same key", async t => {
  const f = fixture(t); let release!: () => void;
  f.metadataGate = new Promise<void>(resolve => { release = resolve; });
  const first = f.call(), second = f.call({ ...f.request, prompt: "Competing initial message" });
  const settled = Promise.allSettled([first, second]);
  for (let i = 0; i < 50 && !f.nativeCreates; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.nativeCreates, 1); release();
  const result = await settled;
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(result.filter(r => r.status === "rejected").length, 1);
  assert.equal(f.sends, 1); assert.equal(f.record().state, "completed");
});


test("a matching remote in-flight receipt never starts another metadata creation", async t => {
  const f = fixture(t); f.metadataNotStarted = true;
  await assert.rejects(f.call(), CodexMetadataNotStartedError); f.metadataNotStarted = false;
  const before = f.record(); f.remoteState = "creating"; f.remoteHash = before.callerIntentHash;
  await assert.rejects(f.call(), /uncertain/);
  assert.equal(f.nativeCreates, 0); assert.equal(f.sends, 0);
  assert.equal(f.record().callerIntentHash, before.callerIntentHash); assert.equal(f.record().state, "uncertain");
});

test("a matching completed metadata receipt is recovered without another native creation", async t => {
  const f = fixture(t); f.metadataNotStarted = true;
  await assert.rejects(f.call(), CodexMetadataNotStartedError); f.metadataNotStarted = false;
  f.remoteHash = f.record().callerIntentHash; f.remoteState = "completed";
  const id = "019f0000-0000-7000-8000-000000000299";
  f.remoteResult = { threadId: id, thread: { id, title: f.request.title, cwd: f.rootDir, updatedAt: "2026-11-04T00:00:00Z", source: "synthetic", initialTurnStatus: "not-requested" } };
  await f.call(); assert.equal(f.nativeCreates, 0); assert.equal(f.sends, 1); assert.equal(f.sent.threadId, id);
});
