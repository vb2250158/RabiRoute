import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexAgentScan, scanAgentAdapters } from "./managerApi.js";

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
  assert.equal(catalogCalls, 1);
  assert.deepEqual(codex.sessions, [{
    id: expectedId,
    name: "MonsterGirl / 伊莉娅 策划美术",
    projectPath: "D:/MonsterGirl",
    updatedAt: "2026-07-18T08:01:05.000Z"
  }]);
});
