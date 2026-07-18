import assert from "node:assert/strict";
import test from "node:test";
import { bindCodexSessionForSave } from "./shared/codexSessionBinding.js";
import { handleAgentThreadRequest, type AgentThreadDriver } from "./agentThreads.js";

test("saving a Rabi route switches its binding to the selected existing Desktop task", async () => {
  const gateway = {
    id: "RabiLink",
    name: "RabiLink",
    agentAdapters: ["codex"],
    codexThreadId: "019f0000-0000-7000-8000-000000000021",
    codexThreadName: "Rabi",
    codexCwd: process.cwd()
  };
  const requests: unknown[] = [];

  await bindCodexSessionForSave(gateway, async (request) => {
    requests.push(request);
    return {
      statusCode: 200,
      data: {
        resolution: "id",
        thread: {
          id: "019f0000-0000-7000-8000-000000000021",
          title: "Rabi",
          cwd: process.cwd(),
          updatedAt: "2026-07-16T00:00:00Z"
        }
      }
    };
  });

  assert.deepEqual(requests, [{
    action: "resolve",
    threadId: "019f0000-0000-7000-8000-000000000021",
    title: "Rabi",
    cwd: process.cwd(),
    createIfMissing: true
  }]);
  assert.equal(gateway.codexThreadId, "019f0000-0000-7000-8000-000000000021");
  assert.equal(gateway.codexThreadName, "Rabi");
  assert.equal(gateway.codexCwd, process.cwd());
});

test("saving a new Rabi task creates once, persists its id, and reuses it on the next save", async () => {
  const createdId = "019f0000-0000-7000-8000-000000000022";
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async (threadId) => threadId === createdId ? {
      id: createdId,
      title: "新的 Rabi 会话",
      cwd: process.cwd(),
      updatedAt: "2026-07-16T00:00:00Z"
    } : (() => { throw new Error("Codex Desktop task was not found"); })(),
    create: async (params) => {
      createCount += 1;
      return {
        id: createdId,
        title: params.title,
        cwd: params.cwd,
        updatedAt: "2026-07-16T00:00:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };
  const gateway = {
    id: "RabiLink",
    name: "RabiLink",
    agentAdapters: ["codex"],
    codexThreadId: "",
    codexThreadName: "新的 Rabi 会话",
    codexCwd: process.cwd()
  };
  const resolve = (request: Parameters<typeof handleAgentThreadRequest>[0]) =>
    handleAgentThreadRequest(request, { allowedWorkspaces: [process.cwd()] }, driver);

  await bindCodexSessionForSave(gateway, resolve);
  await bindCodexSessionForSave(gateway, resolve);

  assert.equal(createCount, 1);
  assert.equal(gateway.codexThreadId, createdId);
  assert.equal(gateway.codexThreadName, "新的 Rabi 会话");
  assert.equal(gateway.codexCwd, process.cwd());
});

test("saving an explicitly typed Rabi name with its old id cleared creates the new binding", async () => {
  const createdId = "019f0000-0000-7000-8000-000000000024";
  let createCount = 0;
  const driver: AgentThreadDriver = {
    list: async () => [],
    read: async (threadId) => ({
      id: threadId,
      title: "旧 Desktop 名字",
      cwd: process.cwd(),
      updatedAt: "2026-07-16T00:00:00Z"
    }),
    create: async (params) => {
      createCount += 1;
      return {
        id: createdId,
        title: params.title,
        cwd: params.cwd,
        updatedAt: "2026-07-16T00:01:00Z",
        source: "test",
        initialTurnStatus: "not-requested"
      };
    },
    send: async () => undefined
  };
  const gateway = {
    id: "RabiLink",
    name: "RabiLink",
    agentAdapters: ["codex"],
    codexThreadId: "",
    codexThreadName: "Rabi 新名字",
    codexCwd: process.cwd()
  };

  await bindCodexSessionForSave(
    gateway,
    (request) => handleAgentThreadRequest(request, { allowedWorkspaces: [process.cwd()] }, driver)
  );

  assert.equal(createCount, 1);
  assert.equal(gateway.codexThreadId, createdId);
  assert.equal(gateway.codexThreadName, "Rabi 新名字");
});
