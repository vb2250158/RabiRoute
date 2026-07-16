import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexAgentScan } from "./managerApi.js";

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
