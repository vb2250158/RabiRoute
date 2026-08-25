import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexAgentScan, scanAgentAdapters, scanDshAgentAdapter } from "./managerApi.js";
import {
  agentAdapterManifest,
  agentAdapterTypes
} from "../shared/agentAdapterCapabilities.js";

test("Codex scan requires the Desktop owner for delivery", () => {
  const scan = buildCodexAgentScan({
    codexBins: [],
    projects: [],
    sessions: [{ id: "configured-route", name: "RabiRoute QQ Monitor" }],
    desktopReady: false
  });

  assert.equal(scan.installed, false);
  assert.deepEqual(scan.transport, { protocol: "Codex Desktop IPC", mode: "desktop-owner" });
  assert.deepEqual(scan.host, { name: "Codex/ChatGPT Desktop", required: true });
  assert.match(scan.warnings?.join(" ") ?? "", /Desktop 未就绪/);
  assert.match(scan.warnings?.join(" ") ?? "", /不会启动备用 Runtime/);
});

test("Codex scan exposes the project-local bootstrap runtime without changing delivery ownership", () => {
  const runtimePath = "C:/Projects/RabiRoute/node_modules/@openai/codex/bin/codex.js";
  const scan = buildCodexAgentScan({
    codexBins: [runtimePath, runtimePath],
    projects: [],
    sessions: [],
    desktopReady: true
  });

  assert.equal(scan.installed, true);
  assert.deepEqual(scan.installCandidates, [{ label: "@openai/codex", path: runtimePath }]);
  assert.match(scan.label, /Codex/);
  assert.match(scan.label, /ChatGPT/);
  assert.deepEqual(scan.transport, { protocol: "Codex Desktop IPC", mode: "desktop-owner" });
});

test("Codex settings scan uses the Desktop user-facing task catalog", async () => {
  const expectedId = "019f0000-0000-7000-8000-000000000059";
  let catalogCalls = 0;
  const result = await scanAgentAdapters({
    rootDir: process.cwd(),
    runtimes: [],
    projects: [],
    cwdOptions: [],
    codexBins: [],
    copilotSessions: [],
    copilotBins: [],
    marvisAppIds: [],
    checkHttpEndpoint: async () => false,
    resolveWingetCopilot: () => null,
    listCodexSessions: async () => {
      catalogCalls += 1;
      return [{
        id: expectedId,
        name: "MonsterGirl / 伊莉娅 策划美术",
        projectPath: "D:/MonsterGirl",
        updatedAt: "2026-07-18T08:01:05.000Z"
      }];
    }
  } as Parameters<typeof scanAgentAdapters>[0] & {
    listCodexSessions: () => Promise<Array<{
      id: string;
      name: string;
      projectPath: string;
      updatedAt: string;
    }>>;
  });

  const codex = (result.agents as Record<string, { sessions?: Array<{ id?: string; name: string }> }>).codex;
  const legacy = result.legacy as Record<string, unknown>;
  assert.deepEqual(legacy.threadNames, result.threadNames);
  assert.deepEqual(legacy.cwdOptions, result.cwdOptions);
  assert.deepEqual(legacy.copilotSessions, result.copilotSessions);
  assert.deepEqual(legacy.copilotBins, result.copilotBins);
  assert.deepEqual(legacy.marvisAppIds, result.marvisAppIds);
  assert.equal(catalogCalls, 1);
  assert.deepEqual(codex.sessions, [{
    id: expectedId,
    name: "MonsterGirl / 伊莉娅 策划美术",
    projectPath: "D:/MonsterGirl",
    updatedAt: "2026-07-18T08:01:05.000Z"
  }]);

  const agents = result.agents as Record<string, {
    type: string;
    label: string;
    maturity: string;
    transport?: { protocol: string; mode: string };
    host?: { name: string; required: boolean };
  }>;
  for (const type of agentAdapterTypes) {
    const manifest = agentAdapterManifest(type);
    assert.equal(agents[type]?.type, manifest.type);
    assert.equal(agents[type]?.label, manifest.label);
    assert.equal(agents[type]?.maturity, manifest.maturity);
    assert.deepEqual(agents[type]?.transport, manifest.transport);
    assert.deepEqual(agents[type]?.host, manifest.host);
  }
});

test("Codex settings scan returns a bounded task page with a continuation offset", async () => {
  const requested: Array<{ limit?: number; offset?: number; query?: string }> = [];
  const sessions = Array.from({ length: 3 }, (_, index) => ({
    id: `thread-${index}`,
    name: `Task ${index}`,
    projectPath: "C:/Projects/RabiRoute",
    updatedAt: `2026-08-18T00:00:0${index}.000Z`
  }));
  const result = await scanAgentAdapters({
    rootDir: process.cwd(),
    runtimes: [],
    projects: [],
    cwdOptions: [],
    codexBins: [],
    copilotSessions: [],
    copilotBins: [],
    marvisAppIds: [],
    checkHttpEndpoint: async () => false,
    resolveWingetCopilot: () => null,
    listCodexSessions: async (options) => {
      requested.push(options);
      return sessions.slice(options.offset, options.offset + options.limit);
    }
  }, { codexLimit: 2, codexOffset: 0, codexQuery: "Task" });

  const codex = (result.agents as Record<string, {
    sessions?: Array<{ id?: string }>;
    sessionPage?: { offset: number; limit: number; returned: number; hasMore: boolean; nextOffset?: number };
  }>).codex;
  assert.deepEqual(requested, [{ limit: 3, offset: 0, query: "Task" }]);
  assert.deepEqual(codex.sessions?.map((session) => session.id), ["thread-0", "thread-1"]);
  assert.deepEqual(codex.sessionPage, {
    offset: 0,
    limit: 2,
    returned: 2,
    hasMore: true,
    nextOffset: 2
  });
});

test("Codex settings scan stops a stalled task catalog and records the timed-out stage", async () => {
  const startedAt = performance.now();
  const result = await scanAgentAdapters({
    rootDir: process.cwd(),
    runtimes: [],
    projects: [],
    cwdOptions: [],
    codexBins: [],
    copilotSessions: [],
    copilotBins: [],
    marvisAppIds: [],
    checkHttpEndpoint: async () => false,
    resolveWingetCopilot: () => null,
    listCodexSessions: async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return [];
    }
  }, { codexCatalogTimeoutMs: 100 });
  const elapsedMs = performance.now() - startedAt;
  const codex = (result.agents as Record<string, { warnings?: string[] }>).codex;
  const operations = result.__performanceOperations as Array<{
    operation: string;
    durationMs: number;
    error: boolean;
  }>;
  const catalogOperation = operations.find(item => item.operation === "manager.agent_scan.codex_catalog");

  assert.ok(elapsedMs < 1_000, `expected bounded scan, got ${elapsedMs.toFixed(1)} ms`);
  assert.match(codex.warnings?.join(" ") ?? "", /任务目录.*超时/);
  assert.equal(operations.length >= 1, true);
  assert.equal(catalogOperation?.error, true);
  assert.ok((catalogOperation?.durationMs ?? Infinity) < 200, "Codex catalog timeout must remain independently bounded.");
});


test("DSH settings scan exposes endpoint, projects, sessions, and local pagination", async () => {
  const requested: Array<{ baseUrl: string; limit: number; offset: number; query?: string }> = [];
  const result = await scanAgentAdapters({
    rootDir: process.cwd(),
    runtimes: [{
      definition: {
        agentAdapters: ["dsh"],
        dshBaseUrl: "http://127.0.0.1:3080/",
        dshCwd: process.cwd(),
        dshSessionName: "主人格"
      }
    }],
    projects: [],
    cwdOptions: [],
    codexBins: [],
    codexSessions: [],
    copilotSessions: [],
    copilotBins: [],
    marvisAppIds: [],
    checkHttpEndpoint: async (url) => url === "http://127.0.0.1:3080",
    resolveWingetCopilot: () => null,
    readDshRabiRoutePluginStatus: async () => ({
      active: true,
      version: "0.1.2",
      managerBaseUrl: "http://127.0.0.1:8790",
      enforceAgentCommunication: true,
      requestTimeoutMs: 30000,
      tools: ["rabiroute_agent_threads", "rabiroute_agent_send", "rabiroute_manager_api"]
    }),
    listDshSessions: async (query) => {
      requested.push(query);
      return [0, 1, 2].map((index) => ({
        id: `session-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        name: `DSH 会话 ${index + 1}`,
        projectPath: process.cwd(),
        updatedAt: `2026-08-20T00:00:0${index}.000Z`
      }));
    }
  }, { dshLimit: 2, dshOffset: 0, dshQuery: "DSH" });

  const dsh = (result.agents as Record<string, {
    installed: boolean;
    endpoints?: Array<{ url: string; healthy?: boolean }>;
    projects?: Array<{ path: string }>;
    sessions?: Array<{ id?: string }>;
    sessionPage?: { offset: number; limit: number; returned: number; hasMore: boolean; nextOffset?: number };
  }>).dsh;
  assert.deepEqual(requested, [{
    baseUrl: "http://127.0.0.1:3080",
    limit: 3,
    offset: 0,
    query: "DSH"
  }]);
  assert.equal(dsh.installed, true);
  assert.equal(dsh.endpoints?.[0]?.healthy, true);
  assert.equal(dsh.projects?.some((project) => project.path === process.cwd()), true);
  assert.equal(dsh.sessions?.length, 2);
  assert.deepEqual(dsh.sessionPage, {
    offset: 0,
    limit: 2,
    returned: 2,
    hasMore: true,
    nextOffset: 2
  });
});


test("dedicated DSH scan does not wait for the Codex catalog or other adapters", async () => {
  let codexCatalogCalls = 0;
  const startedAt = performance.now();
  const result = await Promise.race([
    scanDshAgentAdapter({
      rootDir: process.cwd(),
      runtimes: [{ definition: { dshBaseUrl: "http://127.0.0.1:3080", dshCwd: process.cwd() } }],
      checkHttpEndpoint: async () => true,
      listCodexSessions: async () => {
        codexCatalogCalls += 1;
        await new Promise(() => undefined);
        return [];
      },
      readDshRabiRoutePluginStatus: async () => ({
      active: true,
      version: "0.1.2",
      managerBaseUrl: "http://127.0.0.1:8790",
      enforceAgentCommunication: true,
      requestTimeoutMs: 30000,
      tools: ["rabiroute_agent_threads", "rabiroute_agent_send", "rabiroute_manager_api"]
    }),
    listDshSessions: async () => [{
        id: "session-00000000-0000-4000-8000-000000000001",
        name: "DSH 主人格",
        projectPath: process.cwd(),
        updatedAt: "2026-08-20T00:00:00.000Z"
      }]
    }, { dshLimit: 20 }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("dedicated DSH scan timed out")), 200))
  ]);

  assert.equal(codexCatalogCalls, 0);
  assert.ok(performance.now() - startedAt < 200);
  assert.equal(result.agents.dsh.installed, true);
  assert.deepEqual(result.agents.dsh.sessions?.map((session) => session.id), [
    "session-00000000-0000-4000-8000-000000000001"
  ]);
  assert.equal(result.cwdOptions.includes(process.cwd()), true);
});


test("dedicated DSH scan retries one transient session.list 404", async () => {
  let calls = 0;
  const result = await scanDshAgentAdapter({
    rootDir: process.cwd(),
    runtimes: [],
    checkHttpEndpoint: async () => true,
    readDshRabiRoutePluginStatus: async () => ({
      active: true,
      version: "0.1.2",
      managerBaseUrl: "http://127.0.0.1:8790",
      enforceAgentCommunication: true,
      requestTimeoutMs: 30000,
      tools: ["rabiroute_agent_threads", "rabiroute_agent_send", "rabiroute_manager_api"]
    }),
    listDshSessions: async () => {
      calls += 1;
      if (calls === 1) throw new Error("DSH session.list transport failed with HTTP 404.");
      return [{
        id: "session-00000000-0000-4000-8000-000000000002",
        name: "DSH 计划秘书",
        projectPath: process.cwd()
      }];
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.agents.dsh.sessions?.length, 1);
  assert.doesNotMatch(result.agents.dsh.warnings?.join(" ") ?? "", /读取 DSH 会话失败/);
});


test("DSH scan reports live RabiRoute plugin status", async () => {
  const result = await scanDshAgentAdapter({
    rootDir: process.cwd(),
    checkHttpEndpoint: async () => true,
    dshSessions: [],
    readDshRabiRoutePluginStatus: async () => ({
      active: true,
      version: "0.1.2",
      managerBaseUrl: "http://127.0.0.1:8790",
      enforceAgentCommunication: true,
      requestTimeoutMs: 30000,
      tools: ["rabiroute_agent_threads", "rabiroute_agent_send", "rabiroute_manager_api"]
    })
  });
  const plugin = result.agents.dsh.plugins?.[0];
  assert.deepEqual(plugin, {
    id: "rabiroute-agent",
    name: "RabiRoute Agent",
    installed: true,
    healthy: true,
    version: "0.1.2",
    details: [
      "Manager：http://127.0.0.1:8790",
      "Agent 通信约束：已启用",
      "模型工具：3/3"
    ]
  });
});

test("DSH scan diagnoses a missing RabiRoute plugin", async () => {
  const result = await scanDshAgentAdapter({
    rootDir: process.cwd(),
    checkHttpEndpoint: async () => true,
    dshSessions: [],
    readDshRabiRoutePluginStatus: async () => {
      throw new Error("DSH rabirouteAgent/status transport failed with HTTP 404.");
    }
  });
  assert.equal(result.agents.dsh.plugins?.[0]?.installed, false);
  assert.equal(result.agents.dsh.plugins?.[0]?.healthy, false);
  assert.match(result.agents.dsh.warnings?.join(" ") ?? "", /安装或更新 dsh-private-plugins.*重启 DSH/);
});

test("DSH scan rejects a mismatched RabiRoute plugin version", async () => {
  const result = await scanDshAgentAdapter({
    rootDir: process.cwd(),
    checkHttpEndpoint: async () => true,
    dshSessions: [],
    readDshRabiRoutePluginStatus: async () => ({
      active: true,
      version: "0.0.9",
      managerBaseUrl: "http://127.0.0.1:8790",
      enforceAgentCommunication: true,
      requestTimeoutMs: 30000,
      tools: ["rabiroute_agent_threads", "rabiroute_agent_send", "rabiroute_manager_api"]
    })
  });
  assert.equal(result.agents.dsh.plugins?.[0]?.installed, true);
  assert.equal(result.agents.dsh.plugins?.[0]?.healthy, false);
  assert.match(result.agents.dsh.warnings?.join(" ") ?? "", /版本为 0\.0\.9.*要求 0\.1\.2/);
});
