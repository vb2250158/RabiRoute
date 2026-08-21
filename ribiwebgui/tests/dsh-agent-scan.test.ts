import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const catalogSource = fs.readFileSync(new URL("../../src/manager/agentAdapterCatalog.ts", import.meta.url), "utf8");
const workerPoolSource = fs.readFileSync(new URL("../../src/manager/agentAdapterCatalogWorkerPool.ts", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../../src/manager/agentAdapterCatalogWorker.ts", import.meta.url), "utf8");

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

test("Agent adapter catalog owns the dedicated DSH scan route", () => {
  assert.match(catalogSource, /AGENT_ADAPTER_CATALOG_PLUGIN_INSTANCE_ID = "manager:agent-adapter-catalog"/);
  const start = catalogSource.indexOf('const allScan = requestUrl.pathname === "/api/scan/agents"');
  const end = catalogSource.indexOf("export function mountAgentAdapterCatalogPlugin", start);
  const block = catalogSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /requestUrl\.pathname === "\/api\/scan\/agents\/dsh"/);
  assert.match(block, /dshScan[\s\S]*context\.service\.scanDsh\(dshScanOptions\(requestUrl\), requestLifetime\.signal\)/);
  assert.doesNotMatch(block, /scanDshAgentAdapter/);
});

test("Agent adapter catalog dispatches DSH scans through its owned worker pool", () => {
  const start = catalogSource.indexOf("  scanDsh(");
  const end = catalogSource.indexOf("  workerStatus()", start);
  const block = catalogSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /this\.workerPool\.query<Record<string, unknown>>\(\{[\s\S]*kind: "dsh"/);
  assert.match(workerPoolSource, /fork\(workerEntryPath\(\)/);
  assert.match(workerPoolSource, /stopChildProcessTree\(worker\)/);
  assert.match(workerSource, /task\.kind === "dsh"[\s\S]*scanDshAgentAdapter\(context, task\.options\)[\s\S]*scanAgentAdapters\(context, task\.options\)/);
});

test("DSH plugin diagnostics render the live health fields", () => {
  assert.match(pageSource, /RabiRoute Agent<\/code> 的运行状态、版本、Manager 地址、通信约束和模型工具/);
  assert.match(pageSource, /plugin\.healthy === false \? "未就绪" : "已加载"/);
  assert.match(pageSource, /plugin\.details \?\? \[\]/);
});
