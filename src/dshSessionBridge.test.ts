import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDshSession, listDshSessions, readDshSession, listDshModels,
  normalizeDshModelCatalogForTest, sendDshSessionMessage, renameDshSession,
  resolveDshSession, type DshModelSelection
} from "./dshSessionBridge.js";

type RpcRequest = { type: string; rpcId: string; method: string; payload: { args: Record<string, any> } };
type SessionRow = {
  sessionId: string; updatedAt: number; running: boolean; cwd?: string;
  projections?: { values?: { title?: string; modelSelection?: { next: DshModelSelection | null; lastUsed: DshModelSelection | null } } };
};
const id = (n: number) => `session-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, title = `Agent ${n}`): SessionRow => ({
  sessionId: id(n), updatedAt: 1000 + n, running: false, cwd: "C:\\work\\example", projections: { values: { title } }
});
const selection = { provider: "example-provider", model: "reasoner", reasoningEffort: "high" };
const catalog = { groups: [{ id: "example-provider", name: "Example", models: [{
  id: "reasoner", name: "Reasoner", reasoning: { defaultEffort: "high", efforts: [{ id: "high", name: "High" }] }
}] }], failures: [{ id: "offline", name: "Offline", message: "not connected" }] };

// Wire contract from current session-controller/index.ts, types.ts and workspace-controller.
// list returns all rows; it has no server pagination/nextCursor. history page's default 50 is unrelated.
function installDshRpcStub(rows: SessionRow[], response?: (body: RpcRequest) => unknown) {
  const originalFetch = globalThis.fetch;
  const originalAuthFile = process.env.RABI_DSH_AUTH_FILE;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-bridge-test-"));
  process.env.RABI_DSH_AUTH_FILE = path.join(temp, "auth.json");
  const launchLogPath = path.join(temp, "launch.log");
  fs.writeFileSync(launchLogPath, "dsh web: http://127.0.0.1:3080/?token=fixture-token\n");
  fs.writeFileSync(process.env.RABI_DSH_AUTH_FILE, JSON.stringify({ endpoints: [{ baseUrl: "http://127.0.0.1:3080", launchLogPath }] }));
  const requests: RpcRequest[] = [];
  const workspaces = new Map<string, string>();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "http://127.0.0.1:3080/?token=fixture-token") {
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "dsh-auth-fixture=fixture-cookie; HttpOnly; Path=/" } });
    }
    const body = JSON.parse(String(init?.body)) as RpcRequest;
    assert.equal(String(input), `http://127.0.0.1:3080/api/${body.method}`);
    assert.equal(init?.method, "POST");
    assert.equal(body.type, "client-request");
    assert.match(body.rpcId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(body.payload), ["args"]);
    const args = body.payload.args;
    const key = body.method === "session/list" ? "_request" : "request";
    assert.deepEqual(Object.keys(args), body.method === "session/modelCatalog" ? [] : [key]);
    const request = args[key];
    requests.push(body);
    let value: unknown;
    if (body.method === "session/list") {
      assert.deepEqual(request, {});
      value = { items: rows };
    } else if (body.method === "workspace/create") {
      assert.deepEqual(Object.keys(request), ["path"]);
      const workspaceId = `workspace-${workspaces.size + 1}`;
      workspaces.set(workspaceId, request.path);
      value = { workspace: { workspaceId, path: request.path, title: "Example", sessionIds: [], createdAt: "", updatedAt: "" }, created: true };
    } else if (body.method === "session/create") {
      assert.ok(workspaces.has(request.workspaceId));
      assert.equal("cwd" in request, false);
      const item = row(rows.length + 1);
      item.sessionId = request.sessionId || item.sessionId;
      item.cwd = workspaces.get(request.workspaceId);
      rows.push(item);
      value = { sessionId: item.sessionId };
    } else if (body.method === "session/rename") {
      const item = rows.find(item => item.sessionId === request.sessionId);
      assert.ok(item);
      item.projections = { values: { title: request.title } };
      value = { title: request.title, seq: 1 };
    } else if (body.method === "session/modelCatalog") {
      value = catalog;
    } else if (body.method === "session/selectModel") {
      assert.deepEqual(request, { sessionId: id(1), ...selection });
      value = { selected: selection };
    } else if (body.method === "session/prompt") {
      assert.equal(request.sessionId, id(1));
      assert.match(request.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(request.mode, "steer");
      assert.ok(Array.isArray(request.content));
      value = { accepted: true };
    } else throw new Error(`Unexpected RPC: ${body.method}`);
    const result = response?.(body) ?? { ok: true, value };
    return new Response(JSON.stringify({ rpcId: body.rpcId, result }), { status: 200 });
  }) as typeof fetch;
  return { requests, restore() {
    globalThis.fetch = originalFetch;
    if (originalAuthFile === undefined) delete process.env.RABI_DSH_AUTH_FILE;
    else process.env.RABI_DSH_AUTH_FILE = originalAuthFile;
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}

test("complete owner list: filter and paginate locally beyond 50/100; read exact late ID", async () => {
  const rows = Array.from({ length: 230 }, (_, i) => row(i + 1));
  rows.slice(220).forEach(item => { item.cwd = "C:\\work\\other"; });
  const stub = installDshRpcStub(rows);
  try {
    const result = await listDshSessions({ query: "Agent", offset: 200, limit: 25, allowedWorkspaces: ["c:/work/example/"] });
    assert.equal(result.length, 20);
    assert.equal(result[0]?.title, "Agent 20");
    assert.equal(stub.requests.length, 1);
    assert.equal((await readDshSession(id(230))).id, id(230));
    const resolved = await resolveDshSession({ sessionId: id(220), title: "changed", cwd: "C:\\work\\example", createIfMissing: true });
    assert.equal(resolved.kind, "id");
    assert.ok(stub.requests.every(request => request.method === "session/list"));
  } finally { stub.restore(); }
});

test("resolver chooses uniquely latest matching title, reports ties and workspace mismatches", async () => {
  const rows = [row(1, "Secretary"), row(2, "Secretary")];
  const stub = installDshRpcStub(rows);
  const params = { title: "Secretary", cwd: "C:\\work\\example", createIfMissing: false };
  try {
    const latest = await resolveDshSession(params);
    assert.equal(latest.kind, "name");
    if (latest.kind === "name") assert.equal(latest.thread.id, id(2));
    rows[0]!.updatedAt = rows[1]!.updatedAt;
    assert.equal((await resolveDshSession(params)).kind, "ambiguous");
    assert.equal((await resolveDshSession({ ...params, sessionId: id(1), cwd: "C:\\other" })).kind, "workspace-mismatch");
    await assert.rejects(renameDshSession({ sessionId: id(1), title: "New", cwd: "C:\\other" }), /workspace different/);
    assert.ok(stub.requests.every(request => request.method === "session/list"));
  } finally { stub.restore(); }
});

test("workspace registration, session creation and rename use named request arguments", async () => {
  const stub = installDshRpcStub([]);
  try {
    const created = await createDshSession({ title: "Secretary", cwd: "C:\\work\\example", agentPreset: "default", sessionId: id(1) });
    assert.equal(created.title, "Secretary");
    assert.equal(created.cwd, "C:\\work\\example");
    assert.deepEqual(stub.requests.map(r => r.method), ["workspace/create", "session/create", "session/rename", "session/list"]);
    assert.deepEqual(stub.requests[1]?.payload.args.request, { workspaceId: "workspace-1", agentPreset: "default", sessionId: id(1) });
  } finally { stub.restore(); }
});

test("current model catalog is no-argument session/modelCatalog with reasoning and failures", async () => {
  const stub = installDshRpcStub([]);
  try {
    assert.deepEqual(await listDshModels(), normalizeDshModelCatalogForTest(catalog));
    assert.deepEqual((await listDshModels()).models[0], { provider: "example-provider", providerName: "Example", id: "reasoner", name: "Reasoner", defaultReasoningEffort: "high", reasoningEfforts: [{ id: "high" }] });
    assert.deepEqual((await listDshModels()).warnings, ["Offline：not connected"]);
  } finally { stub.restore(); }
});

test("explicit model selection uses projected next, avoids redundant default writes, then steers content", async () => {
  const rows = [row(1)];
  const stub = installDshRpcStub(rows);
  const params = { sessionId: id(1), prompt: "Exact source context", cwd: "C:\\work\\example", modelSelection: selection, requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  try {
    await sendDshSessionMessage(params);
    assert.deepEqual(stub.requests.map(r => r.method), ["session/list", "session/selectModel", "session/prompt"]);
    assert.deepEqual(stub.requests[2]?.payload.args.request, { requestId: params.requestId, sessionId: id(1), mode: "steer", content: [{ type: "text", text: params.prompt }] });
    rows[0]!.projections!.values!.modelSelection = { next: selection, lastUsed: { ...selection, model: "older" } };
    stub.requests.length = 0;
    await sendDshSessionMessage(params);
    assert.deepEqual(stub.requests.map(r => r.method), ["session/list", "session/prompt"]);
  } finally { stub.restore(); }
});

test("missing session model fails closed without selecting or prompting", async () => {
  const stub = installDshRpcStub([]);
  try { await assert.rejects(sendDshSessionMessage({ sessionId: id(1), prompt: "test", cwd: "C:\\work\\example", modelSelection: selection }), /not found/); }
  finally { stub.restore(); }
});

test("image rejection reuses request identity and current prompt endpoint; no implicit model switch", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-image-test-"));
  const image = path.join(temp, "sample.png");
  fs.writeFileSync(image, Buffer.from("image-fixture"));
  const stub = installDshRpcStub([], body => body.payload.args.request?.content?.some((part: any) => part.type === "image")
    ? { ok: false, error: { code: "session/attachment-invalid", message: "Model does not support image input." } } : undefined);
  try {
    const result = await sendDshSessionMessage({ sessionId: id(1), prompt: "source context", cwd: "C:\\work\\example", imagePaths: [image] });
    assert.ok(result.warning);
    assert.deepEqual(stub.requests.map(r => r.method), ["session/prompt", "session/prompt"]);
    const first = stub.requests[0]!.payload.args.request;
    const second = stub.requests[1]!.payload.args.request;
    assert.equal(first.requestId, second.requestId);
    assert.notEqual(stub.requests[0]!.rpcId, stub.requests[1]!.rpcId);
    assert.deepEqual(first.content[1], { type: "image", mediaType: "image/png", data: Buffer.from("image-fixture").toString("base64"), name: "sample.png" });
    assert.ok(second.content[0].text.startsWith("source context"));
  } finally { stub.restore(); fs.rmSync(temp, { recursive: true, force: true }); }
});

test("owner rejection and missing acceptance never claim delivery or try old RPC", async () => {
  for (const response of [{ ok: false, error: { code: "session/agent-busy", message: "prompt rejected" } }, { ok: true, value: {} }]) {
    const stub = installDshRpcStub([], () => response);
    try {
      await assert.rejects(sendDshSessionMessage({ sessionId: id(1), prompt: "test", cwd: "C:\\work\\example" }), /rejected|acceptance/);
      assert.deepEqual(stub.requests.map(r => r.method), ["session/prompt"]);
    } finally { stub.restore(); }
  }
});
