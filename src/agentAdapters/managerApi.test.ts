import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexAgentScan } from "./managerApi.js";

test("Codex scan derives installation from the project-pinned runtime", () => {
  const scan = buildCodexAgentScan({
    codexBins: [],
    projects: [],
    sessions: [{ id: "configured-route", name: "RabiRoute QQ Monitor" }]
  });

  assert.equal(scan.installed, false);
  assert.deepEqual(scan.transport, { protocol: "codex app-server", mode: "shared-websocket" });
  assert.deepEqual(scan.host, { name: "Codex\/ChatGPT desktop", required: false });
  assert.match(scan.warnings?.join(" ") ?? "", /无法启动共享 Runtime/);
  assert.doesNotMatch(scan.warnings?.join(" ") ?? "", /Desktop IPC|fallback/);
});

test("Codex scan exposes the project-local app-server runtime", () => {
  const runtimePath = "C:/Projects/RabiRoute/node_modules/@openai/codex/bin/codex.js";
  const scan = buildCodexAgentScan({
    codexBins: [runtimePath, runtimePath],
    projects: [],
    sessions: []
  });

  assert.equal(scan.installed, true);
  assert.deepEqual(scan.installCandidates, [{ label: "@openai/codex", path: runtimePath }]);
  assert.match(scan.label, /Codex/);
  assert.match(scan.label, /ChatGPT/);
});
