import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import { LanAgentRegistry, LanAgentNodeNameConflictError, type LanAgentTask } from "./lanAgentRegistry.js";
import { agentInstanceDisplayName } from "../shared/agentInstance.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";

type ConnectedClient = {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  waitFor: (type: string) => Promise<Record<string, unknown>>;
};

test("authenticated connect advertises current release content without creating a task", async () => {
  const statePath = temporaryStatePath();
  const observed: string[] = [];
  const registry = new LanAgentRegistry({ statePath, currentRelease: nodeId => {
    observed.push(nodeId); return { version: "0.1.0", releaseDigest: (nodeId === "alpha" ? "a" : "b").repeat(64) };
  } });
  const server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "fixture" });
  const port = await listen(server);
  let client: ConnectedClient | undefined;
  let other: ConnectedClient | undefined;
  try {
    client = await connectNode(port, "fixture", "alpha");
    assert.deepEqual((await client.waitFor("connected")).release, { version: "0.1.0", releaseDigest: "a".repeat(64) });
    other = await connectNode(port, "fixture", "beta");
    assert.deepEqual((await other.waitFor("connected")).release, { version: "0.1.0", releaseDigest: "b".repeat(64) });
    assert.deepEqual(observed, ["alpha", "beta"]);
    assert.equal(registry.listTasks().length, 0);
  } finally {
    client?.socket.close(); other?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("node aliases persist offline and survive connector reconnects without changing Agent identities", async () => {
  const statePath = temporaryStatePath();
  const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "fixture" });
  const port = await listen(server);
  let client: ConnectedClient | undefined;
  try {
    const agents = [{ agentId: "first", name: "Worker", provider: "codex-desktop", enabled: true }];
    client = await connectNode(port, "fixture", "alpha", agents);
    const closed = new Promise<void>(resolve => client!.socket.once("close", () => resolve()));
    client.socket.close();
    await closed;
    registry.setNodeName("alpha", "  Build computer  ", "");
    assert.equal(registry.listInstances()[1]?.name, "Build computer");
    assert.equal(registry.listNodes()[0]?.connected, false);
    assert.throws(() => registry.setNodeName("alpha", "Other", ""), LanAgentNodeNameConflictError);
    for (const value of [42, "x".repeat(81), "multi\nline"]) {
      assert.throws(() => registry.setNodeName("alpha", value, "Build computer"));
    }
    assert.throws(() => registry.setNodeName("missing", "Other", ""));
    const restored = new LanAgentRegistry({ statePath });
    assert.equal(restored.listInstances()[1]?.name, "Build computer");
    restored.close();
    client = await connectNode(port, "fixture", "alpha", agents);
    assert.equal(registry.listInstances()[1]?.name, "Build computer");
    assert.deepEqual(registry.listInstances()[1]?.agents.map(({ agentId, name, provider, enabled }) => ({ agentId, name, provider, enabled })), agents);
    assert.equal(registry.listInstances()[1]?.instanceId, "alpha");
    registry.setNodeName("alpha", " ", "Build computer");
    assert.equal(registry.listInstances()[1]?.name, undefined);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).nodes[0].name, undefined);
  } finally {
    client?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("reported computer names survive reload, follow OS renames and never overwrite aliases", async () => {
  const statePath = temporaryStatePath();
  const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "fixture" });
  const port = await listen(server);
  let client: ConnectedClient | undefined;
  try {
    client = await connectNode(port, "fixture", "alpha", [], "explicit-session-v1", "  Workstation-A  ");
    assert.equal(agentInstanceDisplayName(registry.listInstances()[1]!), "Workstation-A");
    assert.equal(registry.getNode("alpha")?.name, undefined);
    registry.setNodeName("alpha", "My build machine", "");
    client.socket.close();
    await new Promise<void>(resolve => client!.socket.once("close", resolve));
    client = await connectNode(port, "fixture", "alpha", [], "explicit-session-v1", "Workstation-B");
    assert.equal(agentInstanceDisplayName(registry.listInstances()[1]!), "My build machine");
    assert.equal(registry.listInstances()[1]?.hostname, "Workstation-B");
    registry.setNodeName("alpha", "", "My build machine");
    assert.equal(agentInstanceDisplayName(registry.listInstances()[1]!), "Workstation-B");
    const restored = new LanAgentRegistry({ statePath });
    assert.equal(agentInstanceDisplayName(restored.listInstances()[1]!), "Workstation-B");
    assert.equal(restored.listInstances()[1]?.connected, false);
    restored.close();
    client.socket.close();
    await new Promise<void>(resolve => client!.socket.once("close", resolve));
    client = await connectNode(port, "fixture", "alpha");
    assert.equal(agentInstanceDisplayName(registry.listInstances()[1]!), "Workstation-B");
    assert.equal(agentInstanceDisplayName({ instanceId: "legacy-offline" }), "legacy-offline");
  } finally {
    client?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("instance identity survives restart and management replies stay on their authenticated connection", async () => {
  const statePath = temporaryStatePath();
  const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "fixture" });
  const port = await listen(server);
  let alpha: ConnectedClient | undefined;
  let beta: ConnectedClient | undefined;
  try {
    const agents = [{ agentId: "first", name: "Agent", provider: "codex-desktop", enabled: true }];
    alpha = await connectNode(port, "fixture", "alpha", agents);
    beta = await connectNode(port, "fixture", "beta", agents);
    assert.equal(registry.listInstances()[0]?.local, true);
    assert.equal(registry.listInstances()[1]?.agents[0]?.agentId, "first");
    const pending = registry.manageAgent("alpha", "scan", {});
    const request = await alpha.waitFor("manageAgent");
    beta.socket.send(JSON.stringify({ type: "managementResult", requestId: request.requestId, result: "wrong-owner" }));
    alpha.socket.send(JSON.stringify({ type: "managementResult", requestId: request.requestId, result: "right-owner" }));
    assert.equal(await pending, "right-owner");
    const restored = new LanAgentRegistry({ statePath });
    assert.equal(restored.localInstanceId, registry.localInstanceId);
    restored.close();
    const disconnected = registry.manageAgent("alpha", "scan", {});
    alpha.socket.close();
    await assert.rejects(disconnected, /disconnected/);
  } finally {
    alpha?.socket.close(); beta?.socket.close(); registry.close();
    await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("node credentials authenticate the computer and its single instance switch gates execution", async () => {
  const statePath = temporaryStatePath();
  let credentialValid = true;
  let enabled = false;
  const registry = new LanAgentRegistry({ statePath,
    nodeEnabled: () => enabled,
    authenticateNode: token => credentialValid && token === "node-fixture" ? { nodeId: "alpha" } : null,
  });
  const server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "admin-fixture" });
  const port = await listen(server);
  let client: ConnectedClient | undefined;
  try {
    client = await connectNode(port, "node-fixture", "alpha", [{ agentId: "first", name: "Worker", provider: "codex-desktop", enabled: true }]);
    assert.equal(registry.listInstances()[1]?.enabled, false);
    assert.throws(() => registry.assignTask({ nodeId: "alpha", agentId: "first", targetAgent: "codex-desktop", threadId: "explicit-thread", message: "fixture" }), /disabled/);
    enabled = true;
    assert.equal(registry.listInstances()[1]?.agents[0]?.enabled, true);
    assert.doesNotThrow(() => registry.assignTask({ nodeId: "alpha", targetAgent: "codex-desktop", threadId: "explicit-thread", message: "fixture" }));
    const closed = new Promise<void>(resolve => client!.socket.once("close", () => resolve()));
    credentialValid = false;
    client.socket.send(JSON.stringify({ type: "heartbeat" }));
    await closed;
  } finally {
    client?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("backend catalogs never register sessions or change computer authority", async () => {
 const statePath=temporaryStatePath(); const authority=new LanAgentAuthority({statePath:path.join(path.dirname(statePath),"authority.json")});
 const credential=authority.enroll(authority.issueBootstrapTicket().ticket,"alpha");const registry=new LanAgentRegistry({statePath,authenticateNode:token=>authority.authenticate(token)});const server=http.createServer();registry.attach(server,{enabled:()=>true,getToken:()=>"unused"});const port=await listen(server);
 let client:ConnectedClient|undefined;
 try {client=await connectNode(port,credential.token,"alpha",[{agentId:"backend",name:"Backend",provider:"dsh",sessionId:"old-session",enabled:true}]);
 assert.equal(registry.getInstanceAgent("alpha","backend")?.sessionId,undefined);assert.deepEqual(authority.getSnapshot().nodes,[{nodeId:"alpha",enabled:true}]);
 const task=registry.assignTask({nodeId:"alpha",targetAgent:"dsh",threadId:"unregistered-session",message:"fixture"});await client.waitFor("assignTask");assert.equal(task.threadId,"unregistered-session");
 client.socket.send(JSON.stringify({type:"agentCatalog",agents:[]}));client.socket.send(JSON.stringify({type:"not-supported"}));await client.waitFor("error");
 assert.ok(authority.authenticate(credential.token));assert.equal(registry.listInstances()[1]?.agents.length,0);
 }finally{client?.socket.close();registry.close();await closeServer(server);fs.rmSync(path.dirname(statePath),{recursive:true,force:true});}
});

function temporaryStatePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-lan-agent-registry-"));
  return path.join(root, "state.json");
}

test("bad registry rows retain original bytes and identities while a healthy node works and reloads", async () => {
  const statePath = temporaryStatePath();
  const badNode = { nodeId: "damaged", version: "0.1.0", platform: "win32", agents: [null] };
  const badTask = { taskId: "broken-task", nodeId: "alpha", idempotencyKey: "reserved-key", status: "unknown", original: "keep me" };
  const badReceipt = { taskId: "broken-result", nodeId: "alpha", idempotencyKey: "reserved-result", eventId: "reserved-event", resultHash: "bad" };
  const original = JSON.stringify({ schemaVersion: 2, nodes: [null, badNode], tasks: [null, badTask], resultReceipts: [null, badReceipt] }, null, 3);
  fs.writeFileSync(statePath, original);
  const registry = new LanAgentRegistry({ statePath });
  const backups = () => fs.readdirSync(path.dirname(statePath)).filter(name => name.includes(".before-record-isolation-"));
  assert.equal(backups().length, 1); assert.equal(fs.readFileSync(path.join(path.dirname(statePath), backups()[0]), "utf8"), original);
  assert.equal(registry.storageDiagnostics().length, 6);
  const server = http.createServer(); registry.attach(server, { enabled: () => true, getToken: () => "fixture" }); const port = await listen(server);
  let healthy: ConnectedClient | undefined, damaged: ConnectedClient | undefined;
  try {
    damaged = await connectNode(port, "fixture", "damaged", undefined, "explicit-session-v1", undefined, "error");
    assert.match(String((await damaged.waitFor("error")).error), /identity is isolated/);
    assert.equal(registry.getNode("damaged"), undefined);
    healthy = await connectNode(port, "fixture", "alpha");
    const input = { nodeId: "alpha", targetAgent: "codex-desktop", threadId: "exact-session", message: "normal", taskId: "fresh", idempotencyKey: "fresh-key" };
    for (const conflicting of [{ taskId: "broken-task" }, { taskId: " broken-task " }, { idempotencyKey: " reserved-key " }, { taskId: "broken-result" }]) {
      assert.throws(() => registry.assignTask({ ...input, ...conflicting }), /evidence is isolated/);
    }
    const task = registry.assignTask(input); await healthy.waitFor("assignTask");
    healthy.socket.send(JSON.stringify({ type: "taskResult", taskId: task.taskId, eventId: "reserved-event", status: "completed", summary: "done" }));
    assert.match(String((await healthy.waitFor("error")).error), /result evidence is isolated/);
    assert.equal(healthy.messages.some(message => message.type === "resultAck"), false);
    healthy.socket.send(JSON.stringify({ type: "taskResult", taskId: task.taskId, eventId: "fresh-event", status: "completed", summary: "done" }));
    await healthy.waitFor("resultAck");
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(saved.nodes.slice(-2), [null, badNode]); assert.deepEqual(saved.tasks.slice(-2), [null, badTask]);
    assert.deepEqual(saved.resultReceipts.slice(-2), [null, badReceipt]);
    const restored = new LanAgentRegistry({ statePath });
    try {
      assert.equal(restored.assignTask(input).status, "completed");
      assert.equal(restored.getNode("alpha")?.connected, false);
      assert.throws(() => restored.assignTask({ ...input, taskId: "broken-result", idempotencyKey: "new" }), /evidence is isolated/);
    } finally { restored.close(); }
    assert.equal(backups().length, 1, "unchanged isolated records retain one original snapshot across healthy writes/restarts");
    assert.equal(fs.readFileSync(path.join(path.dirname(statePath), backups()[0]), "utf8"), original);
  } finally {
    healthy?.socket.close(); damaged?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("duplicate scopes, result events and inconsistent task receipts isolate their complete identity group", () => {
  const statePath = temporaryStatePath(), now = new Date().toISOString();
  const task = (taskId: string, key = taskId): LanAgentTask => ({ taskId, nodeId: "alpha", idempotencyKey: key,
    targetAgent: "codex-desktop", threadId: "session", message: "original", status: "completed", result: "done", createdAt: now, updatedAt: now });
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const receipt = (value: LanAgentTask, eventId?: string) => ({ taskId: value.taskId, nodeId: value.nodeId, idempotencyKey: value.idempotencyKey,
    status: value.status, createdAt: now, updatedAt: now,
    assignmentHash: hash({ targetAgent: value.targetAgent, threadId: value.threadId, message: value.message }),
    resultHash: hash({ status: value.status, result: value.result }), ...(eventId ? { eventId, payloadHash: "a".repeat(64) } : {}) });
  const healthy = task("healthy"), a = task("scope-a", "shared"), b = task("scope-b", "shared"), c = task("event-a"), d = task("event-b"), mismatch = task("mismatch");
  const rawTasks = [healthy, a, b, c, d, mismatch], rawReceipts = [receipt(healthy), receipt(a), receipt(b), receipt(c, "same-event"), receipt(d, "same-event"), { ...receipt(mismatch), assignmentHash: "b".repeat(64) }];
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, nodes: [], tasks: rawTasks, resultReceipts: rawReceipts }));
  let registry = new LanAgentRegistry({ statePath });
  try {
    assert.deepEqual(registry.listTasks().map(value => value.taskId), ["healthy"]);
    for (const item of [a, b, c, d, mismatch]) assert.throws(() => registry.assignTask(item), /evidence is isolated/);
    assert.equal(registry.assignTask(healthy).taskId, "healthy");
    registry.close(); registry = new LanAgentRegistry({ statePath });
    assert.deepEqual(registry.listTasks().map(value => value.taskId), ["healthy"]);
    const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const row of rawTasks) assert.ok(stored.tasks.some((value: unknown) => JSON.stringify(value) === JSON.stringify(row)));
    for (const row of rawReceipts) assert.ok(stored.resultReceipts.some((value: unknown) => JSON.stringify(value) === JSON.stringify(row)));
  } finally { registry.close(); fs.rmSync(path.dirname(statePath), { recursive: true, force: true }); }
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("test server did not return a TCP port"));
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function connectNode(port: number, token: string, nodeId: string, agents?: Array<Record<string, unknown>>, taskTargeting: string | null = "explicit-session-v1", hostname?: string, helloReply = "connected"): Promise<ConnectedClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/lan-agent/connect`);
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, Array<(message: Record<string, unknown>) => void>>();
  const waitFor = (type: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const existing = messages.find(message => message.type === type);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2_000);
    const queued = waiters.get(type) ?? [];
    queued.push(message => { clearTimeout(timer); resolve(message); });
    waiters.set(type, queued);
  });
  socket.on("message", value => {
    const message = JSON.parse(value.toString()) as Record<string, unknown>;
    messages.push(message);
    const pending = waiters.get(String(message.type ?? ""));
    waiters.delete(String(message.type ?? ""));
    pending?.forEach(resolve => resolve(message));
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "authenticate", token }));
  await waitFor("authenticated");
  socket.send(JSON.stringify({ type: "hello", node: { nodeId, hostname, version: "0.1.0", platform: "win32-x64", agentTypes: [...new Set(["codex-desktop", ...(agents ?? []).map(agent => agent.provider)])], allowedWorkspaces: ["C:/work"], agents, taskTargeting } }));
  await waitFor(helloReply);
  return { socket, messages, waitFor };
}

test("LAN Agent registry authenticates, persists state, routes updates, and protects task ownership", async () => {
  const statePath = temporaryStatePath();
  const root = path.dirname(statePath);
  const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer((_request, response) => response.end("ok"));
  const detach = registry.attach(server, { enabled: () => true, getToken: () => "lan-token" });
  const port = await listen(server);
  let alpha: ConnectedClient | undefined;
  let beta: ConnectedClient | undefined;
  try {
    const invalid = new WebSocket(`ws://127.0.0.1:${port}/api/lan-agent/connect`);
    await new Promise<void>((resolve, reject) => { invalid.once("open", resolve); invalid.once("error", reject); });
    invalid.send(JSON.stringify({ type: "authenticate", token: "wrong-token" }));
    await new Promise<void>(resolve => invalid.once("close", () => resolve()));

    alpha = await connectNode(port, "lan-token", "node-alpha", [{ agentId: "worker", name: "Worker", provider: "codex-desktop", enabled: true }]);
    assert.deepEqual(registry.listNodes().map(node => node.nodeId), ["node-alpha"]);
    const update = registry.requestUpdate("node-alpha", "0.2.0");
    assert.equal(update.updateState, "requested");
    assert.equal((await alpha.waitFor("updateAvailable")).version, "0.2.0");

    const task = registry.assignTask({ nodeId: "node-alpha", agentId: "worker", targetAgent: "codex-desktop", threadId: "explicit-thread", message: "Inspect the workspace", cwd: "C:/work", idempotencyKey: "task-key" });
    assert.equal(task.status, "delivered");
    assert.throws(() => registry.assignTask({ nodeId: "node-alpha", agentId: "worker", targetAgent: "codex-desktop", threadId: "explicit-thread", message: "Different payload", cwd: "C:/work", idempotencyKey: "task-key" }), /different message/);
    assert.throws(() => registry.assignTask({ nodeId: "node-alpha", agentId: "worker", targetAgent: "codex-desktop", threadId: "other-thread", message: "Inspect the workspace", cwd: "C:/work", idempotencyKey: "task-key" }), /different message/);
    await assert.rejects(registry.waitForTaskAcceptance(task.taskId, 5), /not confirmed/);
    assert.equal(((await alpha.waitFor("assignTask")).task as { taskId?: unknown } | undefined)?.taskId, task.taskId);
    alpha.socket.send(JSON.stringify({ type: "ackTask", taskId: task.taskId }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listTasks()[0]?.status, "acknowledged");
    const accepted = registry.waitForTaskAcceptance(task.taskId);
    alpha.socket.send(JSON.stringify({ type: "progress", taskId: task.taskId, summary: "owner accepted" }));
    assert.equal((await accepted).status, "progress");

    beta = await connectNode(port, "lan-token", "node-beta", [{ agentId: "worker", name: "Old connector", provider: "codex-desktop", enabled: true }], null);
    assert.throws(() => registry.assignTask({ nodeId: "node-beta", agentId: "worker", targetAgent: "codex-desktop", threadId: "explicit-thread", message: "must not fall back" }), /Upgrade.*explicit-session-v1/);
    assert.equal(registry.listTasks().length, 1);
    assert.equal(registry.requestUpdate("node-beta", "0.2.3").targetVersion, "0.2.3");
    beta.socket.send(JSON.stringify({ type: "taskResult", taskId: task.taskId, status: "completed", summary: "not allowed" }));
    await beta.waitFor("error");
    assert.equal(registry.listTasks().find(item => item.taskId === task.taskId)?.status, "progress");

    alpha.socket.send(JSON.stringify({ type: "taskResult", taskId: task.taskId, status: "completed", summary: "done" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listTasks().find(item => item.taskId === task.taskId)?.status, "completed");
    alpha.socket.send(JSON.stringify({ type: "updateResult", status: "updating" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listNodes().find(node => node.nodeId === "node-alpha")?.updateState, "updating");
    alpha.socket.send(JSON.stringify({ type: "updateResult", status: "updated" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(registry.listNodes().find(node => node.nodeId === "node-alpha")?.updateState, "updated");

    const restored = new LanAgentRegistry({ statePath });
    assert.equal(restored.listNodes().find(node => node.nodeId === "node-alpha")?.connected, false);
    assert.equal(restored.listTasks().find(item => item.taskId === task.taskId)?.status, "completed");
    restored.close();
  } finally {
    alpha?.socket.close();
    beta?.socket.close();
    detach();
    registry.close();
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function waitForMessageCount(client: ConnectedClient, type: string, count: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); client.socket.off("message", check); };
    const check = () => {
      const messages = client.messages.filter(message => message.type === type);
      if (messages.length >= count) { cleanup(); resolve(messages[count - 1]); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type} #${count}`)); }, 2_000);
    client.socket.on("message", check); check();
  });
}

test("task results ACK only a persisted result and deduplicate across reconnects and Manager restarts", async () => {
  const statePath = temporaryStatePath();
  let registry = new LanAgentRegistry({ statePath });
  let server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "fixture" });
  let port = await listen(server);
  let alpha: ConnectedClient | undefined; let beta: ConnectedClient | undefined;
  try {
    alpha = await connectNode(port, "fixture", "alpha");
    beta = await connectNode(port, "fixture", "beta");
    const task = registry.assignTask({ nodeId: "alpha", targetAgent: "codex-desktop", threadId: "exact-session", message: "Fixture task", idempotencyKey: "stable-assignment" });
    await alpha.waitFor("assignTask");
    let changed = 0; registry.onDeliveryRecoveryEvent(() => changed++);
    const result = { type: "taskResult", eventId: "stable-result-event", taskId: task.taskId, status: "completed", summary: "e".repeat(12_001) };
    alpha.socket.send(JSON.stringify(result));
    assert.deepEqual(await alpha.waitFor("resultAck"), { type: "resultAck", eventId: result.eventId, taskId: task.taskId });
    const accepted = registry.listTasks()[0];
    const committedFile = fs.readFileSync(statePath, "utf8");
    const persisted = JSON.parse(committedFile);
    assert.equal(persisted.tasks[0].status, "completed");
    assert.equal(persisted.resultReceipts[0].eventId, result.eventId);
    assert.equal(accepted.result?.length, 12_000);
    assert.equal(changed, 1);
    alpha.socket.send(JSON.stringify(result));
    await waitForMessageCount(alpha, "resultAck", 2);
    assert.equal(JSON.stringify(registry.listTasks()[0]), JSON.stringify(accepted));
    assert.equal(fs.readFileSync(statePath, "utf8"), committedFile);
    assert.equal(changed, 1);
    alpha.socket.send(JSON.stringify({ type: "progress", taskId: task.taskId, summary: "late progress" }));
    alpha.socket.send(JSON.stringify({ type: "ackTask", taskId: task.taskId }));
    alpha.socket.send(JSON.stringify({ ...result, summary: "e".repeat(12_000) + "changed beyond display cutoff" }));
    assert.match(String((await alpha.waitFor("error")).error), /conflicts/);
    assert.equal(JSON.stringify(registry.listTasks()[0]), JSON.stringify(accepted));
    assert.equal(changed, 1);
    beta.socket.send(JSON.stringify({ ...result, nodeId: "alpha" }));
    assert.match(String((await beta.waitFor("error")).error), /does not own/);
    assert.equal(beta.messages.filter(message => message.type === "resultAck").length, 0);
    const closed = new Promise<void>(resolve => alpha!.socket.once("close", () => resolve()));
    alpha.socket.close(); await closed;
    alpha = await connectNode(port, "fixture", "alpha");
    alpha.socket.send(JSON.stringify(result)); await alpha.waitFor("resultAck");
    assert.equal(JSON.stringify(registry.listTasks()[0]), JSON.stringify(accepted));
    alpha.socket.close(); beta.socket.close(); registry.close(); await closeServer(server);
    alpha = undefined; beta = undefined;
    registry = new LanAgentRegistry({ statePath }); server = http.createServer();
    registry.attach(server, { enabled: () => true, getToken: () => "fixture" }); port = await listen(server);
    alpha = await connectNode(port, "fixture", "alpha");
    let restoredChanges = 0; registry.onDeliveryRecoveryEvent(() => restoredChanges++);
    alpha.socket.send(JSON.stringify(result));
    await alpha.waitFor("resultAck");
    assert.equal(JSON.stringify(registry.listTasks()[0]), JSON.stringify(accepted));
    assert.equal(restoredChanges, 0);
  } finally {
    alpha?.socket.close(); beta?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("task result persistence failure returns no ACK and restores the original task and receipt reservation", async t => {
  const statePath = temporaryStatePath(); const registry = new LanAgentRegistry({ statePath }); const server = http.createServer();
  registry.attach(server, { enabled: () => true, getToken: () => "fixture" }); const port = await listen(server);
  let client: ConnectedClient | undefined;
  try {
    client = await connectNode(port, "fixture", "alpha");
    const task = registry.assignTask({ nodeId: "alpha", targetAgent: "codex-desktop", threadId: "exact-session", message: "Fixture task" });
    await client.waitFor("assignTask"); const before = registry.listTasks()[0]; const saved = fs.readFileSync(statePath, "utf8");
    const rename = fs.renameSync; let fail = true;
    t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
      if (fail && String(to) === statePath) throw Object.assign(new Error("fixture disk unavailable"), { code: "EIO" });
      return rename(from, to);
    });
    const result = { type: "taskResult", eventId: "durable-result", taskId: task.taskId, status: "completed", summary: "Exact result" };
    client.socket.send(JSON.stringify(result));
    assert.match(String((await client.waitFor("error")).error), /fixture disk unavailable/);
    assert.equal(client.messages.filter(message => message.type === "resultAck").length, 0);
    assert.deepEqual(registry.listTasks()[0], before);
    assert.equal(fs.readFileSync(statePath, "utf8"), saved);
    fail = false; client.socket.send(JSON.stringify(result));
    await client.waitFor("resultAck");
    assert.equal(registry.listTasks()[0].status, "completed");
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).resultReceipts[0].eventId, result.eventId);
  } finally {
    t.mock.restoreAll(); client?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("registry retains every unfinished task and durable result/idempotency markers after completed history compaction", async () => {
  const statePath = temporaryStatePath();
  const task = (id: string, status: LanAgentTask["status"], index: number): LanAgentTask => ({ taskId: id, idempotencyKey: `key-${id}`,
    nodeId: "alpha", targetAgent: "codex-desktop", threadId: "exact-session", message: `Fixture ${id}`, status,
    result: status === "completed" ? "done" : undefined, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString() });
  const active = Array.from({ length: 600 }, (_, index) => task(`active-${index}`, "progress", index));
  const terminal = Array.from({ length: 510 }, (_, index) => task(`complete-${index}`, "completed", index + 1_000));
  fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 2, nodes: [], tasks: [...active, ...terminal] }));
  let registry = new LanAgentRegistry({ statePath }); registry.close();
  const compacted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(compacted.tasks.filter((item: LanAgentTask) => item.status === "progress").length, 600);
  assert.equal(compacted.tasks.filter((item: LanAgentTask) => item.status === "completed").length, 500);
  assert.equal(compacted.resultReceipts.length, 510);
  assert.equal(compacted.tasks.some((item: LanAgentTask) => item.taskId === terminal[0].taskId), false);
  registry = new LanAgentRegistry({ statePath });
  const server = http.createServer(); registry.attach(server, { enabled: () => true, getToken: () => "fixture" }); const port = await listen(server);
  let client: ConnectedClient | undefined;
  try {
    client = await connectNode(port, "fixture", "alpha");
    const original = terminal[0];
    assert.equal(registry.assignTask(original).taskId, original.taskId);
    assert.equal((await registry.waitForTaskAcceptance(original.taskId)).status, "completed");
    assert.equal(client.messages.filter(message => message.type === "assignTask").length, 0);
    assert.throws(() => registry.assignTask({ ...original, message: "Changed" }), /different message/);
    client.socket.send(JSON.stringify({ type: "taskResult", eventId: "compacted-result", taskId: original.taskId, status: "completed", summary: "done" }));
    await client.waitFor("resultAck");
    const receipt = JSON.parse(fs.readFileSync(statePath, "utf8")).resultReceipts.find((item: { taskId: string }) => item.taskId === original.taskId);
    assert.equal(receipt.eventId, "compacted-result");
    client.socket.send(JSON.stringify({ type: "progress", taskId: original.taskId, summary: "late" }));
    client.socket.send(JSON.stringify({ type: "taskResult", eventId: "compacted-result", taskId: original.taskId, status: "completed", summary: "done" }));
    await waitForMessageCount(client, "resultAck", 2);
    assert.equal(registry.listTasks(500).find(item => item.taskId === original.taskId)?.status, undefined);
  } finally {
    client?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

test("management exposes no-frame proof only when the original connection is unavailable before sending", async () => {
  const statePath = temporaryStatePath(); const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer(); registry.attach(server, { enabled: () => true, getToken: () => "fixture" }); const port = await listen(server);
  let client: ConnectedClient | undefined;
  try {
    assert.throws(() => registry.manageAgent("alpha", "prepared_delivery", {}), error => {
      assert.equal((error as { code: string }).code, "LAN_AGENT_MANAGEMENT_NOT_SENT");
      assert.equal((error as { deliveryFrameSent: boolean }).deliveryFrameSent, false); return true;
    });
    client = await connectNode(port, "fixture", "alpha");
    const timedOut = registry.manageAgent("alpha", "prepared_delivery", {}, 10);
    await client.waitFor("manageAgent");
    await assert.rejects(timedOut, error => { assert.equal((error as { deliveryFrameSent?: boolean }).deliveryFrameSent, undefined); return true; });
    const disconnected = registry.manageAgent("alpha", "prepared_delivery", {}, 1_000);
    client.socket.close();
    await assert.rejects(disconnected, error => { assert.equal((error as { deliveryFrameSent?: boolean }).deliveryFrameSent, undefined); return true; });
  } finally {
    client?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});

for (const [operation, parameters] of [["delivery_records", { limit: 10 }], ["scan", {}], ["threads", { action: "read" }], ["threads", { action: "list" }]] as const) {
test(`read-only ${operation}/${"action" in parameters ? parameters.action : "query"} management results do not trigger delivery recovery`, async () => {
  const statePath = temporaryStatePath(); const registry = new LanAgentRegistry({ statePath });
  const server = http.createServer(); registry.attach(server, { enabled: () => true, getToken: () => "fixture" }); const port = await listen(server);
  let client: ConnectedClient | undefined;
  try {
    client = await connectNode(port, "fixture", "alpha");
    let changes = 0; registry.onDeliveryRecoveryEvent(() => changes++);
    const pending = registry.manageAgent("alpha", operation, parameters);
    const request = await client.waitFor("manageAgent");
    client.socket.send(JSON.stringify({ type: "managementResult", requestId: request.requestId, result: { records: [] } }));
    assert.deepEqual(await pending, { records: [] });
    assert.equal(changes, 0);
  } finally {
    client?.socket.close(); registry.close(); await closeServer(server);
    fs.rmSync(path.dirname(statePath), { recursive: true, force: true });
  }
});
}

test("unknown registry schemas retain their original bytes without guessed migration", () => {
  for (const schemaVersion of [999, 1, "2", null]) {
    const statePath = temporaryStatePath();
    const original = JSON.stringify({ schemaVersion, nodes: [], tasks: [], future: { retained: true } }, null, 3);
    fs.writeFileSync(statePath, original);
    try {
      assert.throws(() => new LanAgentRegistry({ statePath }), /Invalid remote computer registry/);
      assert.equal(fs.readFileSync(statePath, "utf8"), original);
      assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter(name => name.startsWith(path.basename(statePath))), [path.basename(statePath)]);
    } finally { fs.rmSync(path.dirname(statePath), { recursive: true, force: true }); }
  }
});
test("historical nodes and tasks stay readable without invented assignment receipts or compaction loss", () => {
  const statePath = temporaryStatePath(), time = "2020-01-01T00:00:00.000Z";
  const tasks = Array.from({length: 501}, (_, index) => ({taskId:`legacy-${index}`,nodeId:"legacy",status:"completed",createdAt:time,updatedAt:time}));
  fs.writeFileSync(statePath,JSON.stringify({schemaVersion:2,nodes:[{nodeId:"legacy",connected:false,extension:"kept"}],tasks}));
  const registry = new LanAgentRegistry({statePath});
  try {
    assert.equal(registry.getNode("legacy")?.version,undefined);
    assert.equal(registry.listTasks()[0].threadId,undefined);
    assert.throws(()=>registry.assignTask({nodeId:"legacy",taskId:"legacy-0",idempotencyKey:"new",targetAgent:"dsh",threadId:"session",message:"new"}),/task ID already belongs/);
    registry.setNodeName("legacy","Old device","");
    const stored=JSON.parse(fs.readFileSync(statePath,"utf8"));
    assert.equal(stored.tasks.length,501); assert.deepEqual(stored.resultReceipts,[]);
    assert.equal(stored.nodes[0].extension,"kept"); assert.equal(stored.nodes[0].version,undefined);
    for(const task of stored.tasks) assert.equal(task.threadId,undefined);
  } finally {registry.close(); fs.rmSync(path.dirname(statePath),{recursive:true,force:true});}
});
test("missing legacy node fields remain valid while present malformed public fields are isolated", () => {
  const statePath=temporaryStatePath();
  const invalid=[{name:{}},{remoteAddress:[]},{agentTypes:{}},{allowedWorkspaces:[null]},{terminalShells:1},{computerCapabilities:[false]},{lastSeenAt:"not-a-date"},{connectedAt:17},{lastUpdateAt:null},{updateState:{}},{updateState:["idle"]}];
  const nodes=[{nodeId:"healthy",connected:false},...invalid.map((fields,index)=>({nodeId:`bad-${index}`,connected:false,...fields}))];
  fs.writeFileSync(statePath,JSON.stringify({schemaVersion:2,nodes,tasks:[]}));
  const owner=new LanAgentRegistry({statePath});
  try {
    assert.deepEqual(owner.listNodes().map(node=>node.nodeId),["healthy"]);
    assert.equal(owner.listInstances().filter(instance=>!instance.local).length,1);
    owner.setNodeName("healthy","Still available","");
    const retained=JSON.parse(fs.readFileSync(statePath,"utf8"));
    for(const row of nodes.slice(1)) assert.deepEqual(retained.nodes.find((node:any)=>node.nodeId===row.nodeId),row);
  } finally {owner.close();fs.rmSync(path.dirname(statePath),{recursive:true,force:true});}
});