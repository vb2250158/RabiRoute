import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const managerSource = fs.readFileSync(new URL("../../src/manager/controlPlaneRoutes.ts", import.meta.url), "utf8");

test("DSH refresh and pagination use the dedicated scan endpoint", () => {
  assert.match(pageSource, /async function runDshAgentScan[\s\S]*fetch\(`\/api\/scan\/agents\/dsh/);
  assert.match(pageSource, /loadMoreDshSessions[\s\S]*runDshAgentScan\(\{ append: true/);
  assert.match(pageSource, /function refreshAgentScan[\s\S]*type === "dsh" \? runDshAgentScan : runAgentScan/);
  assert.match(pageSource, /@click="refreshAgentScan\(agent\.type\)"/);
  assert.match(pageSource, /title="按当前地址扫描" @click\.stop="runDshAgentScan"/);
  assert.equal(pageSource.match(/onMounted\(\(\) => \{ void runDshAgentScan/g)?.length ?? 0, 0);
});

test("dedicated DSH scan only merges DSH state", () => {
  const start = pageSource.indexOf("async function runDshAgentScan");
  const end = pageSource.indexOf("async function loadMoreCodexSessions", start);
  const block = pageSource.slice(start, end);
  assert.match(block, /agentScan\.value\.agents = \{[\s\S]*\.\.\.agentScan\.value\.agents,[\s\S]*dsh:/);
  assert.doesNotMatch(block, /\.\.\.\(data\.agents/);
  assert.match(block, /agentScan\.value\.cwdOptions = \[\.\.\.new Set/);
});

test("Manager serves DSH scan without the shared read worker pool", () => {
  const start = managerSource.indexOf('requestUrl.pathname === "/api/scan/agents/dsh"');
  const end = managerSource.indexOf('requestUrl.pathname === "/api/agent/copilot-install"', start);
  const block = managerSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /scanDshAgentAdapter\(agentManagerApiCtx\(\)/);
  assert.doesNotMatch(block, /managerAgentScanWorkerPool/);
});
test("DSH plugin diagnostics render the live health fields", () => {
  assert.match(pageSource, /RabiRoute Agent<\/code> 的运行状态、版本、Manager 地址、通信约束和模型工具/);
  assert.match(pageSource, /plugin\.healthy === false \? "未就绪" : "已加载"/);
  assert.match(pageSource, /plugin\.details \?\? \[\]/);
});
