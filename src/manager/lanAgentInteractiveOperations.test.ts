import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createManagerClient, type ManagerOperationOptions } from "../../apps/rabi-agent/lib/manager-client.mjs";
import { createLanAgentTerminalOperations } from "./lanAgentTerminalRoutes.js";
import { createLanAgentComputerOperations } from "./lanAgentComputerRoutes.js";
import { LanAgentRegistry } from "./lanAgentRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { createApiDiscoveryOperations } from "./apiDiscoveryRoutes.js";
import { LanAgentTerminals } from "./lanAgentTerminals.js";
import { openTerminalEventStream } from "./lanAgentTerminalStream.js";
import { TERMINAL_LIMITS } from "../../apps/rabi-agent/lib/interactive-protocol.mjs";

async function fixture(t: import("node:test").TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "interactive-operations-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "fixture-interactive-node");
  const computers = new LanAgentRegistry({ statePath: path.join(root, "nodes.json"), authenticateNode: token => authority.authenticate(token) });
  const meta = { applicationGenerationId: "interactive-app", managerInstanceId: "interactive-manager", pluginGenerationId: "interactive-plugins", health: { live: true, requiredReady: true, state: "healthy" } };
  const api = new ManagerPluginRouteRegistry(undefined, { identity: () => meta });
  const context = { registry: computers, isManagementRequestAuthorized: () => false };
  const registration = api.registerOperations("interactive", [...createLanAgentTerminalOperations(context), ...createLanAgentComputerOperations(context)]);
  const discovery = api.registerOperations("discovery", createApiDiscoveryOperations(api));
  const server = http.createServer((request, response) => {
    const admitted = evaluateLanAgentRequest(request, authority, true);
    if (admitted.kind === "denied") { response.writeHead(admitted.status).end(); return; }
    if (admitted.kind === "agent") markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (request.headers.authorization === "Bearer fixture-link") markAuthenticatedConnectionRequest(request);
    if (request.url === "/meta") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(meta)); return; }
    const url = new URL(request.url!, "http://localhost");
    registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(url.pathname, body, assertTrustedLanAgentPrincipal(request)?.source));
    if (!api.handle(request, url, response)) response.writeHead(404).end();
  });
  const detach = computers.attach(server, { getToken: () => "", enabled: () => true });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string"); const base = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(base.replace("http:", "ws:") + "/api/lan-agent/connect");
  const sessions = new Map<string, Record<string, unknown>>(), calls: Array<{ requestId: string; operation: string; params: Record<string, unknown> }> = [];
  let intercept: ((message: typeof calls[number]) => boolean) | undefined;
  const reply = (message: typeof calls[number]) => {
    const input = message.params, id = String(input.terminalId);
    let result: unknown;
    if (message.operation === "computer") result = { path: input.path, size: 7, version: "fixture-version", chunkBytes: 65536 };
    else if (input.action === "list") result = { shells: ["cmd"], sessions: [...sessions.values()] };
    else {
      if (input.action === "open") sessions.set(id, { terminalId: id, shell: "cmd", cwd: "fixture-private-cwd", state: "running", createdAt: new Date().toISOString(), nextInputSequence: 1, pid: 1 });
      const session = sessions.get(id)!;
      if (input.action === "input") { session.nextInputSequence = Number(input.sequence) + 1; socket.send(JSON.stringify({ type: "terminalEvent", event: { terminalId: id, type: "output", data: "fixture terminal output 汉字" } })); }
      if (input.action === "close") { session.state = "exited"; session.exitCode = 0; socket.send(JSON.stringify({ type: "terminalEvent", event: { terminalId: id, type: "exit", exitCode: 0 } })); }
      result = session;
    }
    socket.send(JSON.stringify({ type: "managementResult", requestId: message.requestId, result }));
  };
  const connected = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Fixture node did not connect.")), 5000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token: credential.token })));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "authenticated") socket.send(JSON.stringify({ type: "hello", node: { nodeId: "fixture-interactive-node", version: "fixture", platform: "fixture", agents: [], terminalShells: ["cmd"], computerCapabilities: ["files"] } }));
      if (message.type === "connected") { clearTimeout(deadline); resolve(); }
      if (message.type === "manageAgent") { calls.push(message); if (!intercept?.(message)) reply(message); }
    });
    socket.once("error", reject);
  });
  t.after(async () => { socket.terminate(); detach(); computers.close(); server.closeAllConnections(); await Promise.all([registration.dispose(), discovery.dispose()]); await new Promise<void>(resolve => server.close(() => resolve())); });
  await connected;
  const client = createManagerClient({ managerUrl: base, credential: credential.token, agentType: "dsh", sessionId: "full-unregistered-interactive-session" });
  const instanceId = "fixture-interactive-node", terminalId = randomUUID(), target = { instanceId, terminalId };
  const execute = (body: Record<string, unknown>, options: ManagerOperationOptions = {}) => client.invokeOperation("manager.lan-agent.terminals.execute", { path: { instanceId }, body: { terminalId, ...body }, ...options });
  return { root, authority, credential, computers, api, registration, socket, base, client, instanceId, terminalId, target, calls, reply, sessions, execute,
    intercept: (value: typeof intercept) => { intercept = value; } };
}

test("five discovered operations use the original authenticated node, ordered terminal events and computer transport", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.api.catalogSnapshot().operations.filter(row => /manager\.lan-agent\.(terminals|computer)\./.test(row.contract.operationId)).length, 5);
  assert.equal((await fetch(`${f.base}/api/lan-agent/instances/${f.instanceId}/terminals`)).status, 401);
  const opened = await f.execute({ action: "open", shell: "cmd" });
  assert.equal(opened.statusCode, 200, String(opened.body));
  const listed = await f.client.invokeOperation("manager.lan-agent.terminals.list", { path: { instanceId: f.instanceId } });
  assert.equal(listed.statusCode, 200); assert.equal(JSON.parse(String(listed.body)).data.sessions.length, 1);
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); let output = "";
  const stream = f.client.invokeOperation("manager.lan-agent.terminals.events", { path: f.target, onChunk: bytes => { output += bytes.toString(); ready(); } });
  await started; assert.equal((await f.execute({ action: "input", sequence: 1, data: "fixture input" })).statusCode, 200);
  const read = await f.client.invokeOperation("manager.lan-agent.terminals.read", { path: f.target, query: { after: 0, waitMs: 0 } });
  assert.equal(read.statusCode, 200); assert.equal(JSON.parse(String(read.body)).data.nextOutputSequence, 1);
  const stat = await f.client.invokeOperation("manager.lan-agent.computer.execute", { path: { instanceId: f.instanceId }, body: { action: "file.stat", path: "fixture-remote-path" } });
  assert.equal(stat.statusCode, 200); assert.equal(JSON.parse(String(stat.body)).data.chunkBytes, 65536);
  await f.execute({ action: "close" }); assert.equal((await stream).statusCode, 200);
  assert.match(output, /id: 1\ndata: .*fixture terminal output 汉字/); assert.match(output, /"type":"exit"/);
  assert.equal((await fetch(`${f.base}/api/lan-agent/instances/${f.instanceId}/terminals`, { headers: { authorization: "Bearer fixture-link" } })).status, 200);
  assert.deepEqual(f.computers.getNode(f.instanceId)!.agents, []);
});

test("registration retirement cancels a terminal viewer without closing or re-executing the remote session", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.execute({ action: "open", shell: "cmd" });
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const stream = f.client.invokeOperation("manager.lan-agent.terminals.events", { path: f.target, onChunk: () => ready() });
  await started; await f.registration.dispose(); await stream;
  assert.equal(f.registration.activeOperationCount(), 0); assert.equal(f.sessions.get(f.terminalId)!.state, "running");
  assert.equal(f.calls.filter(call => call.params.action === "close").length, 0);
  const remove = Array.from({ length: 4 }, () => f.computers.terminals.subscribe(f.instanceId, f.terminalId, 0, () => {}));
  assert.throws(() => f.computers.terminals.subscribe(f.instanceId, f.terminalId, 0, () => {}), /four/); remove.forEach(fn => fn());
});

test("aborted terminal input retains its operation lease until the original remote response settles", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.execute({ action: "open", shell: "cmd" });
  let sent!: () => void, held!: typeof f.calls[number]; const entered = new Promise<void>(resolve => { sent = resolve; });
  f.intercept(message => { held = message; sent(); return true; });
  const controller = new AbortController(); const request = f.execute({ action: "input", sequence: 1, data: "once" }, { signal: controller.signal });
  await entered; controller.abort(); await request;
  let retired = false; const stopped = f.registration.dispose().then(() => { retired = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(retired, false); assert.ok(f.registration.activeOperationCount() > 0);
  f.reply(held); await stopped; assert.equal(f.calls.filter(call => call.params.action === "input").length, 1);
});

test("an old admission cannot disclose a terminal result after disable and re-enable", { timeout: 15000 }, async t => {
  const f = await fixture(t); let sent!: () => void, held!: typeof f.calls[number]; const entered = new Promise<void>(resolve => { sent = resolve; });
  f.intercept(message => { held = message; sent(); return true; });
  const request = f.execute({ action: "open", shell: "cmd" }); await entered;
  f.authority.setNodeEnabled(f.instanceId, false); f.authority.setNodeEnabled(f.instanceId, true); f.reply(held);
  const response = await request; assert.equal(response.statusCode, 403); assert.equal(response.uncertain, true);
  assert.equal(String(response.body).includes("fixture-private-cwd"), false); assert.equal(f.calls.length, 1);
});

test("revocation after stream creation removes its subscription before returning the denial", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.execute({ action: "open", shell: "cmd" });
  const original = f.computers.terminals.subscribe.bind(f.computers.terminals);
  t.mock.method(f.computers.terminals, "subscribe", (...args: Parameters<typeof original>) => {
    const remove = original(...args); f.authority.setNodeEnabled(f.instanceId, false); f.authority.setNodeEnabled(f.instanceId, true); return remove;
  });
  const response = await f.client.invokeOperation("manager.lan-agent.terminals.events", { path: f.target, onChunk: () => { throw new Error("Revoked output must not escape."); } });
  assert.equal(response.statusCode, 403); t.mock.restoreAll();
  const remove = Array.from({ length: 4 }, () => original(f.instanceId, f.terminalId, 0, () => {})); remove.forEach(fn => fn());
});

test("terminal stream replay emits gap, completes on exit and releases overloaded viewers", { timeout: 15000 }, async () => {
  const owner = new LanAgentTerminals(async () => ({})), terminalId = randomUUID(); await owner.execute("fixture", { action: "open", terminalId });
  for (let index = 0; index < 100; index++) owner.receive("fixture", { terminalId, type: "output", data: "x".repeat(8192) });
  owner.receive("fixture", { terminalId, type: "exit", exitCode: 0 });
  const stream = openTerminalEventStream(owner, "fixture", terminalId, 0, () => {}); const frames: unknown[] = [];
  for await (const frame of stream.frames) frames.push(frame);
  assert.equal((frames[1] as { data: { type: string } }).data.type, "gap"); assert.equal((frames.at(-1) as { data: { type: string } }).data.type, "exit");
  const overloadedId = randomUUID(); await owner.execute("fixture", { action: "open", terminalId: overloadedId });
  for (let index = 0; index < 16; index++) owner.receive("fixture", { terminalId: overloadedId, type: "output", data: "\u0000".repeat(16384) });
  const overloaded = openTerminalEventStream(owner, "fixture", overloadedId, 0, () => {}); assert.equal(overloaded.signal!.aborted, true); await overloaded.cancel(undefined);
  const remove = Array.from({ length: 4 }, () => owner.subscribe("fixture", overloadedId, 16, () => {})); remove.forEach(fn => fn());
});

test("terminal exit stops keepalive while accepted output is waiting for its consumer", { timeout: 15000 }, async t => {
  const owner = new LanAgentTerminals(async () => ({})), terminalId = randomUUID();
  await owner.execute("fixture", { action: "open", terminalId });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stream = openTerminalEventStream(owner, "fixture", terminalId, 0, () => {});
  const iterator = stream.frames[Symbol.asyncIterator]();
  t.after(async () => { await stream.cancel(undefined); await iterator.return?.(); });
  assert.equal((await iterator.next()).done, false);
  owner.receive("fixture", { terminalId, type: "exit", exitCode: 0 });
  t.mock.timers.tick(TERMINAL_LIMITS.heartbeatMs);
  const exit = await iterator.next(); assert.equal((exit.value as { data: { type: string } }).data.type, "exit");
  assert.equal((await iterator.next()).done, true, "Terminal EOF must not be delayed by keepalive frames queued after exit.");
});
