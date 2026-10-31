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
  const operations = fs.readFileSync(new URL("../../src/manager/agentAdapterCatalogOperations.ts", import.meta.url), "utf8");
  const contract = fs.readFileSync(new URL("../../src/manager/agentAdapterCatalogContract.ts", import.meta.url), "utf8");
  assert.match(contract, /key: "dsh", method: "GET", path: "\/api\/scan\/agents\/dsh"/);
  assert.match(operations, /key === "dsh" \? await service\.scanDsh\(options, lifetime\.signal\)/);
  assert.match(operations, /AGENT_CATALOG_OPERATIONS\.map/);
  assert.doesNotMatch(operations, /scanDshAgentAdapter/);
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
  assert.match(pageSource, /v-for="plugin in agentScanFor\(agent\.type\)\?\.plugins \?\? \[\]"/);
  assert.match(pageSource, /plugin\.installed && plugin\.healthy !== false \? 'success' : 'warning'/);
  assert.match(pageSource, /plugin\.healthy === false \? "未就绪" : "已加载"/);
  assert.match(pageSource, /plugin\.details \?\? \[\]/);
});
