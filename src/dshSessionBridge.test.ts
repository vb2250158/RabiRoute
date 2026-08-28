import assert from "node:assert/strict";
import test from "node:test";
import {
  createDshSession,
  listDshSessions,
  normalizeDshModelCatalogForTest,
  sendDshSessionMessage,
  renameDshSession,
  resolveDshSession
} from "./dshSessionBridge.js";

type RpcRequest = { rpcId: string; method: string; payload: Record<string, unknown> };

type SessionRow = {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank?: boolean;
  cwd?: string;
  projections?: { values?: { title?: string } };
};

function installDshRpcStub(rows: SessionRow[]) {
  const originalFetch = globalThis.fetch;
  const requests: RpcRequest[] = [];
  const workspacePaths = new Map<string, string>();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as RpcRequest;
    requests.push(body);
    let value: unknown;
    if (body.method === "session.list") {
      value = { items: rows };
    } else if (body.method === "workspace.create") {
      const workspaceId = `workspace-${workspacePaths.size + 1}`;
      const workspacePath = String(body.payload.path || "");
      workspacePaths.set(workspaceId, workspacePath);
      value = { workspace: { workspaceId, path: workspacePath } };
    } else if (body.method === "session.create") {
      const sessionId = `session-00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
      rows.push({
        sessionId,
        updatedAt: Date.now(),
        running: false,
        cwd: workspacePaths.get(String(body.payload.workspaceId || "")) || String(body.payload.cwd || ""),
        projections: { values: {} }
      });
      value = { sessionId };
    } else if (body.method === "session.rename") {
      const row = rows.find((item) => item.sessionId === body.payload.sessionId);
      if (!row) throw new Error("missing test session");
      row.projections = { values: { title: String(body.payload.title || "") } };
      value = { title: body.payload.title, seq: 1 };
    } else {
      throw new Error(`Unexpected RPC method: ${body.method}`);
    }
    return new Response(JSON.stringify({
      rpcId: body.rpcId,
      result: { ok: true, value }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    requests,
    restore: () => { globalThis.fetch = originalFetch; }
  };
}

test("DSH session catalog applies workspace, query and local pagination after reading the complete owner list", async () => {
  const rows: SessionRow[] = Array.from({ length: 230 }, (_, index) => ({
    sessionId: `session-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    updatedAt: 1_000 + index,
    running: index % 2 === 0,
    cwd: index < 220 ? "C:\\work\\rabi" : "C:\\work\\other",
    projections: { values: { title: `秘书 ${index + 1}` } }
  }));
  const stub = installDshRpcStub(rows);
  try {
    const result = await listDshSessions({
      baseUrl: "http://127.0.0.1:3080/",
      query: "秘书",
      limit: 25,
      offset: 200,
      allowedWorkspaces: ["c:/work/rabi/"]
    });
    assert.equal(result.length, 20);
    assert.equal(result[0]?.title, "秘书 20");
    assert.equal(stub.requests.filter((request) => request.method === "session.list").length, 1);
  } finally {
    stub.restore();
  }
});

test("DSH resolver continues an exact saved id after verifying its workspace", async () => {
  const sessionId = "session-11111111-1111-4111-8111-111111111111";
  const stub = installDshRpcStub([{
    sessionId,
    updatedAt: 2_000,
    running: false,
    cwd: "C:\\work\\rabi",
    projections: { values: { title: "主人格" } }
  }]);
  try {
    const result = await resolveDshSession({
      sessionId,
      title: "显示名可以变化",
      cwd: "c:/work/rabi/",
      createIfMissing: true,
      baseUrl: "http://127.0.0.1:3080"
    });
    assert.equal(result.kind, "id");
    if (result.kind === "id") assert.equal(result.thread.id, sessionId);
  } finally {
    stub.restore();
  }
});

test("DSH resolver chooses the uniquely latest same-name session and rejects an updatedAt tie", async () => {
  const rows: SessionRow[] = [{
    sessionId: "session-22222222-2222-4222-8222-222222222221",
    updatedAt: 2_000,
    running: false,
    cwd: "C:\\work\\rabi",
    projections: { values: { title: "计划秘书" } }
  }, {
    sessionId: "session-22222222-2222-4222-8222-222222222222",
    updatedAt: 3_000,
    running: false,
    cwd: "C:\\work\\rabi",
    projections: { values: { title: "计划秘书" } }
  }];
  const stub = installDshRpcStub(rows);
  try {
    const latest = await resolveDshSession({
      title: "计划秘书",
      cwd: "C:\\work\\rabi",
      createIfMissing: false,
      baseUrl: "http://127.0.0.1:3080"
    });
    assert.equal(latest.kind, "name");
    if (latest.kind === "name") assert.equal(latest.thread.id, rows[1]?.sessionId);

    rows[0]!.updatedAt = 3_000;
    const tied = await resolveDshSession({
      title: "计划秘书",
      cwd: "C:\\work\\rabi",
      createIfMissing: false,
      baseUrl: "http://127.0.0.1:3080"
    });
    assert.equal(tied.kind, "ambiguous");
  } finally {
    stub.restore();
  }
});

test("DSH session creation creates in the requested workspace and assigns the requested title", async () => {
  const stub = installDshRpcStub([]);
  try {
    const created = await createDshSession({
      title: "消息处理 Agent 1",
      cwd: "C:\\work\\rabi",
      baseUrl: "http://127.0.0.1:3080"
    });
    assert.equal(created.title, "消息处理 Agent 1");
    assert.equal(created.cwd, "C:\\work\\rabi");
    assert.deepEqual(stub.requests.map((request) => request.method), [
      "workspace.create",
      "session.create",
      "session.rename",
      "session.list"
    ]);
    const createRequest = stub.requests.find((request) => request.method === "session.create");
    assert.equal(createRequest?.payload.workspaceId, "workspace-1");
    assert.equal("cwd" in (createRequest?.payload || {}), false);
  } finally {
    stub.restore();
  }
});

test("DSH rename fails closed when the saved session belongs to another workspace", async () => {
  const sessionId = "session-33333333-3333-4333-8333-333333333333";
  const stub = installDshRpcStub([{
    sessionId,
    updatedAt: 2_000,
    running: false,
    cwd: "C:\\work\\other",
    projections: { values: { title: "旧名称" } }
  }]);
  try {
    await assert.rejects(renameDshSession({
      sessionId,
      title: "新名称",
      cwd: "C:\\work\\rabi",
      baseUrl: "http://127.0.0.1:3080"
    }), /workspace different/i);
    assert.equal(stub.requests.some((request) => request.method === "session.rename"), false);
  } finally {
    stub.restore();
  }
});


test("DSH model catalog preserves provider identity and reasoning choices", () => {
  assert.deepEqual(normalizeDshModelCatalogForTest({
    groups: [{
      id: "deepseek-official",
      name: "DeepSeek",
      models: [{
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        description: "Reasoning model",
        reasoning: {
          defaultEffort: "high",
          efforts: [{ id: "high", description: "Deep reasoning" }, { id: "max" }]
        }
      }]
    }],
    failures: [{ id: "offline", name: "Offline", message: "not connected" }]
  }), {
    models: [{
      provider: "deepseek-official",
      providerName: "DeepSeek",
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      description: "Reasoning model",
      defaultReasoningEffort: "high",
      reasoningEfforts: [{ id: "high", description: "Deep reasoning" }, { id: "max" }]
    }],
    warnings: ["Offline：not connected"]
  });
});

test("DSH delivery switches the bound session model before queuing the prompt", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as RpcRequest;
    methods.push(body.method);
    const value = body.method === "session.models"
      ? { current: { provider: "deepseek-official", model: "deepseek-v4-flash" }, routable: true, groups: [], failures: [] }
      : body.method === "session.selectModel"
        ? { selected: { provider: body.payload.provider, model: body.payload.model, reasoningEffort: body.payload.reasoningEffort } }
        : body.method === "session.prompt"
          ? { accepted: true }
          : undefined;
    return new Response(JSON.stringify({ rpcId: body.rpcId, result: { ok: true, value } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;
  try {
    await sendDshSessionMessage({
      sessionId: "session-44444444-4444-4444-8444-444444444444",
      prompt: "test",
      cwd: "C:\\work\\rabi",
      modelSelection: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" }
    });
    assert.deepEqual(methods, ["session.models", "session.selectModel", "session.prompt"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
