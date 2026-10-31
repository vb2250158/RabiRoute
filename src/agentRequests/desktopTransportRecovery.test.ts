import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CodexDesktopBridge, CodexDesktopPromptNotSentError } from "../codexDesktopBridge.js";
import { executeEndpointOnOwner } from "./ownerExecution.js";
import { EndpointTransportReceipts } from "./endpointTransportReceipts.js";
import { executePreparedEndpointDelivery } from "./endpointExecution.js";
import { EndpointDeliveryNotSentError } from "./deliveryFailure.js";
import { AgentRequestStore, type AgentRequestPersistence } from "./store.js";
import { executeEndpointAgentDelivery, reconcileEndpointDelivery, EndpointDeliveryRecovery, type EndpointDeliveryOptions } from "./endpointDelivery.js";
import { LanAgentRegistry } from "../manager/lanAgentRegistry.js";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "../manager/agentEndpointDelivery.js";
import { manageInstanceAgent } from "../agentAdapters/instanceManagement.js";

type Request = { type: string; requestId: string; method: string };
function frame(value: unknown) {
  const data = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}
function pipe() { return process.platform === "win32" ? `\\\\.\\pipe\\rabi-no-frame-${randomUUID()}` : path.join(os.tmpdir(), `rabi-${randomUUID()}.sock`); }
async function desktop(address: string, handler: (request: Request, socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>(); const requests: Request[] = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0); const request = JSON.parse(buffer.subarray(4, 4 + size).toString()) as Request;
        buffer = buffer.subarray(4 + size); requests.push(request); handler(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  return { requests, close: async () => { if (!server.listening) return; for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const reply = (socket: net.Socket, request: Request, error?: string) => socket.write(frame({ type: "response", requestId: request.requestId,
  resultType: error ? "error" : "success", ...(error ? { error } : { result: request.method === "initialize" ? { clientId: "fixture" } : {} }) }));
const turn = { threadId: "fixture-owner", prompt: "Frozen original body", cwd: os.tmpdir(), sandbox: "workspace-write" as const };

test("real IPC connect/initialize failures prove zero prompt frames; prompt timeouts and any earlier steer never do", async t => {
  const missing = new CodexDesktopBridge({ pipePaths: [pipe()], requestTimeoutMs: 30 });
  t.after(() => missing.close());
  await assert.rejects(missing.deliver(turn), CodexDesktopPromptNotSentError);
  const initAddress = pipe();
  const initRouter = await desktop(initAddress, () => {}); t.after(() => initRouter.close());
  const init = new CodexDesktopBridge({ pipePaths: [initAddress], requestTimeoutMs: 25 }); t.after(() => init.close());
  await assert.rejects(init.deliver(turn), CodexDesktopPromptNotSentError);
  assert.deepEqual(initRouter.requests.map(x => x.method), ["initialize"]);

  const writtenAddress = pipe();
  const writtenRouter = await desktop(writtenAddress, (request, socket) => { if (request.method === "initialize") reply(socket, request); });
  t.after(() => writtenRouter.close());
  const written = new CodexDesktopBridge({ pipePaths: [writtenAddress], requestTimeoutMs: 25, deliveryReceiptGraceMs: 0, lateStartReconcileMs: 0 });
  t.after(() => written.close());
  await assert.rejects(written.deliver(turn), error => error instanceof Error && !(error instanceof CodexDesktopPromptNotSentError));
  assert.equal(writtenRouter.requests.filter(x => x.method === "thread-follower-steer-turn").length, 1);

  const fallbackAddress = pipe();
  const fallbackRouter = await desktop(fallbackAddress, (request, socket) => reply(socket, request,
    request.method === "thread-follower-steer-turn" ? "no active turn to steer" : undefined));
  t.after(() => fallbackRouter.close());
  const fallback = new CodexDesktopBridge({ pipePaths: [fallbackAddress], requestTimeoutMs: 30 }); t.after(() => fallback.close());
  let authorizations = 0;
  await assert.rejects(fallback.deliver({ ...turn, assertAuthorized: () => { if (++authorizations === 2) throw new Error("start pre-write authority changed"); } }),
    error => error instanceof Error && !(error instanceof CodexDesktopPromptNotSentError));
  assert.deepEqual(fallbackRouter.requests.map(r => r.method), ["initialize", "thread-follower-steer-turn"]);

  const earlierAddress = pipe(); let earlier!: CodexDesktopBridge;
  const earlierRouter = await desktop(earlierAddress, (request, socket) => {
    if (request.method === "initialize") reply(socket, request);
    else reply(socket, request, "no-client-found");
  }); t.after(() => earlierRouter.close());
  earlier = new CodexDesktopBridge({ pipePaths: [earlierAddress], requestTimeoutMs: 30, loadRetryAttempts: 2, loadRetryDelayMs: 1,
    openThread: async () => { earlier.close(); await earlierRouter.close(); } });
  t.after(() => earlier.close());
  // First steer frame was written, then owner loading and reconnect failed.
  await assert.rejects(earlier.deliver(turn), error => error instanceof Error && !(error instanceof CodexDesktopPromptNotSentError));
  assert.equal(earlierRouter.requests.filter(x => x.method === "thread-follower-steer-turn").length, 1);
});

class Memory implements AgentRequestPersistence {
  value: unknown; fail = false;
  read() { return this.value; }
  write(value: unknown) { if (this.fail) throw new Error("fixture Manager commit failed"); this.value = structuredClone(value); }
}

test("real owner IPC no-frame proof survives Manager commit crash, restores original prepared ID and sends once after restart", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-no-frame-"));
  const original = { home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME };
  process.env.CODEX_HOME = root; process.env.CODEX_SQLITE_HOME = root;
  t.after(() => { if (original.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original.home;
    if (original.sqlite === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = original.sqlite;
    fs.rmSync(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,updated_at_ms INTEGER,recency_at INTEGER,recency_at_ms INTEGER,archived INTEGER,first_user_message TEXT)");
  db.prepare("INSERT INTO threads VALUES (?,'Owner',?,'',1,1000,1,1000,0,'existing')").run(turn.threadId, root); db.close();
  const source = { kind: "local", managerInstanceId: "manager", agentId: "source", provider: "dsh", sessionId: "source-session", authorizationIncarnation: "source-epoch" } as const;
  const target = { kind: "local", managerInstanceId: "manager", agentId: "receiver", provider: "codex", sessionId: turn.threadId, authorizationIncarnation: "target-epoch" } as const;
  const persistence = new Memory(); let store = new AgentRequestStore(persistence); const directory = path.join(root, "transport");
  let ledger = new EndpointTransportReceipts(directory); const address = pipe(); let crash = true, failProof = false, sends = 0;
  let bridge = new CodexDesktopBridge({ pipePaths: [address], requestTimeoutMs: 50, deliveryReceiptGraceMs: 0, deliveryReceiptReader: () => true });
  t.after(() => bridge.close());
  const context = () => ({ endpoint: target, assertAuthorized: () => {}, readReceipt: (d: Parameters<typeof executePreparedEndpointDelivery>[0]) => ledger.readReceipt(d),
    beginAttempt: (d: Parameters<typeof executePreparedEndpointDelivery>[0]) => ledger.beginAttempt(d),
    readNotSent: (d: Parameters<typeof executePreparedEndpointDelivery>[0]) => ledger.readNotSentProof(d),
    writeNotSent: async (d: Parameters<typeof executePreparedEndpointDelivery>[0], proof: EndpointDeliveryNotSentError) => {
      if (failProof) throw new Error("fixture transport proof commit failed");
      await ledger.writeNotSent(d, proof); if (crash) persistence.fail = true;
    },
    writeReceipt: (d: Parameters<typeof executePreparedEndpointDelivery>[0], r: Parameters<EndpointTransportReceipts["writeReceipt"]>[1]) => ledger.writeReceipt(d, r),
    send: (d: Parameters<typeof executePreparedEndpointDelivery>[0], guard: () => Promise<void>) => executeEndpointOnOwner(d, {}, guard,
      { sendCodex: async params => { sends++; return bridge.deliver(params); } }) });
  const options = (): EndpointDeliveryOptions => ({ store, managerInstanceId: "manager", authorize: () => {}, resolveSource: () => ({ threadId: source.sessionId, agentType: "agent", agentAdapter: "dsh", endpoint: source }),
    resolveTarget: () => ({ threadId: target.sessionId, agentType: "agent", agentAdapter: "codex", endpoint: target }), resolveExecutionOptions: () => ({ cwd: root }),
    dispatch: async d => { const receipt = await executePreparedEndpointDelivery(d, context()); if (!receipt) throw new Error("unconfirmed"); return receipt; },
    reconcile: d => executePreparedEndpointDelivery(d, context(), true) });
  const request = { action: "send" as const, deliveryId: "stable-caller-key", agentAdapter: "codex" as const, sourceThreadId: source.sessionId, sourceAgentType: "agent" as const,
    threadId: target.sessionId, prompt: "Original immutable body", responsePolicy: "none" as const,
    messageSource: { type: "agent" as const, agentAdapter: "dsh" as const, sessionId: source.sessionId, sessionName: "Source" } };
  const interrupted = await executeEndpointAgentDelivery(request, options());
  assert.equal(interrupted.statusCode, 202);
  assert.equal(interrupted.data.status, "delivery_unconfirmed");
  assert.equal((interrupted.data.delivery as { retryable: boolean }).retryable, false);
  persistence.fail = false; crash = false; store = new AgentRequestStore(persistence); ledger = new EndpointTransportReceipts(directory);
  const frozen = (await store.listEndpointDeliveries())[0]; assert.equal(frozen.state, "dispatching");
  assert.equal(await ledger.readNotSent(frozen), true);
  assert.equal(await ledger.beginAttempt(frozen), false);
  await assert.rejects(executePreparedEndpointDelivery(frozen, context()), EndpointDeliveryNotSentError);
  assert.equal(sends, 1);
  await assert.rejects(reconcileEndpointDelivery(frozen.deliveryId, options()), EndpointDeliveryNotSentError);
  const prepared = (await store.readEndpointDelivery(frozen.deliveryId))!; assert.equal(prepared.state, "prepared");
  const evidenceFile = path.join(directory, fs.readdirSync(directory)[0]);
  const proven = JSON.parse(fs.readFileSync(evidenceFile, "utf8")); assert.equal(proven.state, "not_sent");
  assert.equal(proven.noFrameProof.attemptId, proven.attemptId);
  const router = await desktop(address, (r, socket) => reply(socket, r)); t.after(() => router.close());
  bridge.close(); bridge = new CodexDesktopBridge({ pipePaths: [address], requestTimeoutMs: 50, deliveryReceiptGraceMs: 0, deliveryReceiptReader: () => true });
  const recovery = new EndpointDeliveryRecovery(options(), { minimumDelayMs: 10 }); t.after(() => recovery.stop()); await recovery.start();
  const deadline = Date.now() + 3500;
  while (store.getEndpointDelivery(frozen.deliveryId)?.state !== "committed" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await recovery.stop();
  const received = await executeEndpointAgentDelivery(request, options()); assert.equal(received.statusCode, 200);
  const committed = (await store.readEndpointDelivery(frozen.deliveryId))!;
  assert.equal(committed.prompt, frozen.prompt); assert.equal(committed.promptHash, frozen.promptHash); assert.equal(committed.generation, frozen.generation);
  assert.equal(committed.state, "committed"); assert.equal(sends, 2); // One offline boundary, one real frame.
  assert.equal(router.requests.filter(r => r.method === "thread-follower-steer-turn").length, 1);
  const accepted = JSON.parse(fs.readFileSync(evidenceFile, "utf8")); assert.equal(accepted.attemptSequence, 2);
  assert.equal(accepted.lastNoFrameProof.attemptId, proven.attemptId); assert.notEqual(accepted.attemptId, proven.attemptId);
  assert.equal(await ledger.readNotSent(committed), false);
  assert.equal((await executeEndpointAgentDelivery(request, options())).statusCode, 200); assert.equal(sends, 2);

  // A new attempt must first consume the old proof durably. A crash immediately
  // afterwards cannot use the previous attempt's zero-frame proof a second time.
  bridge.close(); bridge = new CodexDesktopBridge({ pipePaths: [pipe()], requestTimeoutMs: 30 });
  assert.equal((await executeEndpointAgentDelivery({ ...request, deliveryId: "consume-crash" }, options())).statusCode, 503);
  const second = (await store.listEndpointDeliveries()).find(d => d.callerDeliveryId === "consume-crash")!;
  assert.equal(await ledger.readNotSent(second), true);
  second.dispatchAttemptId = await store.markEndpointDispatching(second.deliveryId);
  assert.equal(await ledger.beginAttempt(second), true);
  ledger = new EndpointTransportReceipts(directory); store = new AgentRequestStore(persistence);
  assert.equal(await ledger.readNotSent(second), false); assert.equal(await ledger.beginAttempt(second), false);
  assert.equal(await reconcileEndpointDelivery(second.deliveryId, options()), false);
  assert.equal(store.getEndpointDelivery(second.deliveryId)?.state, "dispatching"); assert.equal(sends, 3);

  // The same real no-frame error without a durable transport proof is unknown.
  failProof = true;
  assert.equal((await executeEndpointAgentDelivery({ ...request, deliveryId: "proof-disk-failure" }, options())).statusCode, 202);
  const failed = (await store.listEndpointDeliveries()).find(d => d.callerDeliveryId === "proof-disk-failure")!;
  assert.equal(failed.state, "dispatching"); assert.equal(await ledger.readNotSent(failed), false);
  failProof = false; store = new AgentRequestStore(persistence); ledger = new EndpointTransportReceipts(directory);
  assert.equal((await executeEndpointAgentDelivery({ ...request, deliveryId: "proof-disk-failure" }, options())).statusCode, 202);
  assert.equal(sends, 4);
});

test("authenticated remote management recovers its durable no-frame proof after lost ACK and restart, then automatically sends the original intent once", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-no-frame-"));
  const env = { home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME };
  process.env.CODEX_HOME = root; process.env.CODEX_SQLITE_HOME = root;
  t.after(() => { if (env.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = env.home;
    if (env.sqlite === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = env.sqlite;
    fs.rmSync(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,updated_at_ms INTEGER,recency_at INTEGER,recency_at_ms INTEGER,archived INTEGER,first_user_message TEXT)");
  db.prepare("INSERT INTO threads VALUES (?,'Owner',?,'',1,1000,1,1000,0,'existing')").run(turn.threadId, root); db.close();
  const registry = new LanAgentRegistry({ statePath: path.join(root, "manager", "registry.json"),
    authenticateNode: token => ["remote", "other"].includes(token) ? { nodeId: token, incarnation: "fixture-epoch" } : null, nodeEnabled: () => true });
  const server = http.createServer(); registry.attach(server, { enabled: () => true, getToken: () => "unused-fixture" });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const clients = new Set<WebSocket>();
  t.after(async () => { for (const socket of clients) socket.terminate(); registry.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const persistence = new Memory(); let store = new AgentRequestStore(persistence);
  const directory = path.join(root, "remote", "transport"); let ledger = new EndpointTransportReceipts(directory);
  const address = pipe(); let bridge = new CodexDesktopBridge({ pipePaths: [address], requestTimeoutMs: 40 }); t.after(() => bridge.close());
  let loseFirstProof = true, alteration: string | undefined, originalProof: Record<string, unknown> | undefined;
  let other!: WebSocket; let preparedCalls = 0, reconcileCalls = 0;
  const connect = async (nodeId: string): Promise<WebSocket> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/lan-agent/connect`); clients.add(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject); socket.once("open", () => socket.send(JSON.stringify({ type: "authenticate", token: nodeId })));
      socket.on("message", bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.type === "authenticated") socket.send(JSON.stringify({ type: "hello", node: { nodeId, version: "fixture", platform: "win32-x64",
          agentTypes: ["codex-desktop"], allowedWorkspaces: [root], agents: [{ agentId: "backend", provider: "codex-desktop", name: "Owner", workspace: root, enabled: true }] } }));
        if (message.type === "connected") resolve();
        if (message.type !== "manageAgent" || nodeId !== "remote") return;
        void (async () => {
          const delivery = message.params.delivery;
          if (message.operation === "prepared_delivery") preparedCalls++; else if (message.operation === "reconcile_prepared_delivery") reconcileCalls++;
          const assertAuthorized = () => { assert.equal(socket.readyState, WebSocket.OPEN); assert.equal(delivery.target.nodeId, nodeId); };
          const result = await manageInstanceAgent(message.operation, message.params, { rootDir: root, defaultWorkspace: root, allowedWorkspaces: [root],
            endpointExecution: { endpoint: delivery.target, assertAuthorized,
              readReceipt: d => ledger.readReceipt(d), beginAttempt: d => ledger.beginAttempt(d), writeReceipt: (d, receipt) => ledger.writeReceipt(d, receipt),
              readNotSent: d => ledger.readNotSentProof(d), writeNotSent: (d, proof) => ledger.writeNotSent(d, proof) },
            ownerTransport: { sendCodex: params => bridge.deliver(params) } });
          const output = result as { status?: string; proof?: Record<string, unknown> };
          if (output?.status === "not_sent") {
            if (loseFirstProof) {
              loseFirstProof = false; originalProof = structuredClone(output.proof);
              // Another authenticated computer cannot answer the original peer's
              // pending request, even with an exact copied positive proof.
              other.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result }));
              await new Promise(resolve => setTimeout(resolve, 15)); socket.close(); return;
            }
            if (alteration && output.proof) output.proof[alteration] = alteration === "attemptId" ? "not-a-uuid" : "changed";
          }
          socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result }));
        })().catch(error => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, error: String(error) })); });
      });
    });
    return socket;
  };
  other = await connect("other"); await connect("remote");
  const factory = () => createAgentEndpointDelivery({ store, registry,
    authority: { getNodeAuthorization: () => ({ incarnation: "fixture-epoch" }) }, config: { getLanAgentDeliveryPolicy: () => ({ enabled: true, incarnation: "fixture-policy" }) },
    receiptDirectory: path.join(root, "manager", "transport"), readLocal: async (_provider: unknown, id: string) => ({ id, title: "Source", cwd: root, archived: false }),
    localOptions: () => ({}) } as unknown as AgentEndpointDeliveryContext);
  const request = { action: "send" as const, deliveryId: "remote-stable-key", threadId: turn.threadId, sourceThreadId: "source-session", sourceAgentType: "agent" as const,
    agentAdapter: "codex" as const, instanceBinding: { instanceId: "remote", agentId: "backend" }, prompt: "Immutable remote message", responsePolicy: "none" as const,
    messageSource: { type: "agent" as const, agentAdapter: "dsh" as const, sessionId: "source-session", sessionName: "Source" } };
  let manager = factory();
  assert.equal((await executeEndpointAgentDelivery(request, manager.options())).statusCode, 202);
  const frozen = (await store.listEndpointDeliveries())[0]; assert.equal(frozen.state, "dispatching");
  assert.equal(preparedCalls, 1); assert.ok(originalProof); assert.equal(await ledger.readNotSent(frozen), true);
  // Recreate both durable state owners; no in-memory proof or alternate task is used.
  store = new AgentRequestStore(persistence); ledger = new EndpointTransportReceipts(directory); manager = factory(); await connect("remote");
  for (const field of ["generation", "promptHash", "executionOptionsHash", "dispatchAttemptId", "attemptId", "endpoint"]) {
    alteration = field;
    await assert.rejects(reconcileEndpointDelivery(frozen.deliveryId, manager.options()), /proof does not match/);
    assert.equal(store.getEndpointDelivery(frozen.deliveryId)?.state, "dispatching");
  }
  alteration = undefined;
  await assert.rejects(reconcileEndpointDelivery(frozen.deliveryId, manager.options()), EndpointDeliveryNotSentError);
  const prepared = (await store.readEndpointDelivery(frozen.deliveryId))!; assert.equal(prepared.state, "prepared");
  assert.equal(prepared.lastNoFrameProof?.attemptId, originalProof!.attemptId); assert.equal(preparedCalls, 1);
  // A proof from the preceding Manager attempt cannot authorize the next one.
  const forkPersistence = new Memory(); forkPersistence.value = structuredClone(persistence.value);
  const nextAttempt = new AgentRequestStore(forkPersistence); await nextAttempt.markEndpointDispatching(frozen.deliveryId);
  await assert.rejects(nextAttempt.markEndpointNotSent(frozen.deliveryId, prepared.lastNoFrameProof), /proof does not match/);
  const router = await desktop(address, (r, socket) => reply(socket, r)); t.after(() => router.close());
  bridge.close(); bridge = new CodexDesktopBridge({ pipePaths: [address], requestTimeoutMs: 80, deliveryReceiptGraceMs: 0, deliveryReceiptReader: () => true });
  await manager.recovery.start(); t.after(() => manager.recovery.stop());
  const deadline = Date.now() + 3500;
  while (store.getEndpointDelivery(frozen.deliveryId)?.state !== "committed" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  await manager.recovery.stop();
  assert.equal(store.getEndpointDelivery(frozen.deliveryId)?.state, "committed");
  assert.equal(router.requests.filter(r => r.method === "thread-follower-steer-turn").length, 1);
  assert.equal(preparedCalls, 2); assert.ok(reconcileCalls >= 7);
  const completed = (await store.readEndpointDelivery(frozen.deliveryId))!;
  assert.equal(completed.promptHash, frozen.promptHash); assert.equal(completed.generation, frozen.generation); assert.equal(completed.prompt, frozen.prompt);
  assert.notEqual(completed.dispatchAttemptId, frozen.dispatchAttemptId);
  assert.equal((await executeEndpointAgentDelivery(request, manager.options())).statusCode, 200); assert.equal(preparedCalls, 2);
});
