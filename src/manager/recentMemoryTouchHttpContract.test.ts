import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { PersonaStorageOwner, createPersonaStorageOperations, type PersonaStorageOperationsContext } from "./personaStorageOperations.js";
import { RoleStorageApplication } from "./roleStorageApplication.js";
import { ManagerStorageMutationPool } from "./managerStorageMutationPool.js";
import { ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { ensurePersonaPlanWorkflow } from "../personaPlanWorkflow.js";

async function contents(directory: string, prefix = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name), key = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(snapshot, await contents(filename, key + "/"));
    else if (entry.isFile()) snapshot[key] = createHash("sha256").update(await fs.readFile(filename)).digest("hex");
  }
  return snapshot;
}
async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "recent-memory-http-owner-")), roleDir = path.join(root, "Fixture");
  await fs.mkdir(roleDir); ensurePersonaPlanWorkflow(roleDir);
  const identity = { applicationGenerationId: "memory-generation", managerInstanceId: "memory-manager" };
  const reads = new ManagerReadWorkerPool({ maxConcurrency: 1, timeoutMs: 30_000 });
  const mutations = new ManagerStorageMutationPool({ rolesRoot: root, ...identity });
  const revisions: Array<string | null> = [], nativeTouch = mutations.touchRecentMemory.bind(mutations);
  mutations.touchRecentMemory = async (...args: Parameters<typeof nativeTouch>) => { revisions.push(args[2].expectedRevision); assert.equal(typeof args[2].authorize, "function"); return nativeTouch(...args); };
  const application = new RoleStorageApplication({ rolesRoot: root, ...identity, currentIdentity: () => identity, readPool: reads, catalogReadPool: reads, mutationPool: mutations });
  let readOnly = false, touches = 0, details = 0, lists = 0;
  let beforeDetail: () => Promise<void> = async () => {};
  const touch = application.commands.touchRecentMemory.bind(application.commands), detail = reads.queryRecentMemoryDetail.bind(reads), list = reads.queryRoleMemoryCatalog.bind(reads);
  application.commands.touchRecentMemory = async (...args: Parameters<typeof touch>) => { touches++; assert.equal(typeof args[2]?.authorize, "function"); return touch(...args); };
  reads.queryRecentMemoryDetail = async (...args: Parameters<typeof detail>) => { details++; await beforeDetail(); return detail(...args); };
  reads.queryRoleMemoryCatalog = async (...args: Parameters<typeof list>) => { lists++; return list(...args); };
  const context: PersonaStorageOperationsContext = { application: () => application, roleDirectory: () => roleDir, identity: () => identity, readOnly: () => readOnly,
    planHistoryContext: async (_request, _body, command) => command, scheduleFeedbackPostCommit: () => {}, reportFeedbackScheduleError: () => {},
    publish: () => {}, rescheduleMemory: () => {}, noteMemoryRunCompleted: () => {}, pools: { knowledge: reads, catalog: reads, read: reads } };
  const owner = new PersonaStorageOwner(context), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("recent-memory-owner", createPersonaStorageOperations(owner));
  const server = http.createServer((request, response) => {
    markAuthenticatedConnectionRequest(request, () => {});
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await owner.stop(); await application.stop(); await reads.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const request = async (tail: string, method = "GET", body?: unknown, headers: Record<string, string> = {}, prefix = "/api/roles/Fixture/") => {
    const response = await fetch(base + prefix + tail, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { root, identity, request, revisions, setReadOnly: (value: boolean) => { readOnly = value; }, holdDetail: (hook: () => Promise<void>) => { beforeDetail = hook; }, counters: () => ({ touches, details, lists }) };
}

test("recent-memory detail GET is pure in read-only mode and fenced in writable mode", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.request("memory/recent", "POST", { id: "memory-fixture", title: "Fixture", focus: "Controlled", content: "Private fixture content", keywords: ["fixture"] }, { "idempotency-key": "memory-create" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id, original = await contents(f.root);
  f.setReadOnly(true);
  const plain = await f.request("memory/recent/" + id);
  assert.equal(plain.status, 200, JSON.stringify(plain.body)); assert.equal(plain.body.data.viewedAt, created.body.data.viewedAt);
  assert.equal(plain.headers.has("idempotency-key"), false); assert.deepEqual(f.counters(), { touches: 0, details: 1, lists: 0 });
  assert.equal((await f.request("memory/recent")).status, 200); assert.deepEqual(f.counters(), { touches: 0, details: 1, lists: 1 });
  assert.deepEqual(await contents(f.root), original, "read-only detail and list must not persist a touch, receipt or other data");
  f.setReadOnly(false);
  const touched = await f.request("memory/recent/" + id, "GET", undefined, { "idempotency-key": "memory-view", "if-match": created.headers.get("etag")! });
  assert.equal(touched.status, 200, JSON.stringify(touched.body)); assert.ok(touched.body.data.viewedAt); assert.ok(touched.headers.get("idempotency-key")); assert.ok(touched.headers.get("etag"));
  const replay = await f.request("memory/recent/" + id, "GET", undefined, { "idempotency-key": "memory-view" }, "/roles/Fixture/");
  assert.equal(replay.status, 200); assert.equal(replay.headers.get("idempotency-key"), touched.headers.get("idempotency-key")); assert.equal(replay.body.data.viewedAt, touched.body.data.viewedAt);
  assert.equal(f.revisions[0], created.headers.get("etag")!.replaceAll('"', ""));
  // View-touch acquires its own fresh CAS revision; a caller revision never replaces the native owner’s read.
  const fresh = await f.request("memory/recent/" + id, "GET", undefined, { "idempotency-key": "memory-fresh", "if-match": '"' + "0".repeat(64) + '"' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body)); assert.equal(f.revisions.at(-1), touched.headers.get("etag")!.replaceAll('"', ""));
  const beforeList = await contents(f.root);
  assert.equal((await f.request("memory/recent")).status, 200); assert.equal(f.counters().details, 1);
  assert.deepEqual(await contents(f.root), beforeList, "writable-mode list is still a pure worker read");
  f.setReadOnly(true); const after = await f.request("memory/recent/" + id);
  assert.equal(after.body.data.viewedAt, fresh.body.data.viewedAt);
});

test("recent-memory read retains its original Manager generation through the real worker await", { timeout: 90_000 }, async t => {
  const f = await fixture(t);
  const created = await f.request("memory/recent", "POST", { id: "memory-fenced", title: "Controlled", focus: "Fixture", content: "Old private fixture", keywords: ["fixture"] }, { "idempotency-key": "fenced-create" });
  assert.equal(created.status, 201, JSON.stringify(created.body)); f.setReadOnly(true);
  const original = await contents(f.root); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.holdDetail(async () => { entered(); await gate; });
  const pending = f.request("memory/recent/" + created.body.data.id); await started;
  f.identity.managerInstanceId = "replacement-manager"; release();
  const response = await pending; assert.equal(response.status, 409); assert.equal(response.body.data, undefined); assert.equal(JSON.stringify(response.body).includes("Old private fixture"), false);
  assert.equal(f.counters().touches, 0); assert.deepEqual(await contents(f.root), original);
});
