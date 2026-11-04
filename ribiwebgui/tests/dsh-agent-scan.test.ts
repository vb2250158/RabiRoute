import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const cardSource = fs.readFileSync(new URL("../src/agentAdapters/DshAgentCard.vue", import.meta.url), "utf8");
const scanSource = fs.readFileSync(new URL("../src/agentAdapters/routeAgentScanController.ts", import.meta.url), "utf8");
const bundleSource = fs.readFileSync(new URL("../src/bundles/agents/dsh.ts", import.meta.url), "utf8");
const workerPoolSource = fs.readFileSync(new URL("../../src/manager/agentAdapterCatalogWorkerPool.ts", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../../src/manager/agentAdapterCatalogWorker.ts", import.meta.url), "utf8");

test("DSH refresh and pagination use the dedicated scan endpoint", () => {
  assert.match(cardSource, /async function runDshAgentScan[\s\S]*props\.context\.refreshScan\(options\)/);
  assert.match(scanSource, /fetch\)\(`\/api\/agent-adapters\/scan\/\$\{encodeURIComponent\(type\)\}/);
  assert.match(pageSource, /runAgentTypeScan\(type, \{ append: true, offset: page\.nextOffset, limit: page\.limit \}\)/);
  assert.match(bundleSource, /params\.set\("dshBaseUrl", route\.dshBaseUrl\.trim\(\)\)/);
  assert.match(pageSource, /@click="refreshAgentScan\(agent\.type\)"/);
  assert.match(cardSource, /title="按当前地址扫描" @click\.stop="runDshAgentScan"/);
  assert.equal(cardSource.match(/onMounted/g)?.length ?? 0, 0);
});

test("dedicated DSH scan only merges DSH state", () => {
  assert.match(scanSource, /observations\.set\(type,/);
  assert.match(scanSource, /agents: Object\.fromEntries\(\[\.\.\.observations\]/);
  assert.doesNotMatch(scanSource, /\.\.\.\(data\.agents/);
  assert.match(scanSource, /cwdOptions: \[\.\.\.new Set/);
});

test("the DSH package owns its canonical scan and compatibility alias", () => {
  const provider = fs.readFileSync(new URL("../../src/agentAdapters/dshManagerProvider.ts", import.meta.url), "utf8");
  const operations = fs.readFileSync(new URL("../../src/agentAdapters/managerNativeOperations.ts", import.meta.url), "utf8");
  const spec = JSON.parse(fs.readFileSync(new URL("../../plugins/builtin/io.rabiroute.agent.dsh/1.0.0/manager-runtime.build.json", import.meta.url), "utf8"));
  assert.match(provider, /createAgentScanOperations\(descriptor\.type/);
  assert.match(provider, /['"]\/api\/scan\/agents\/dsh['"]/);
  assert.match(operations, /\/api\/agent-adapters\/scan\/\$\{type\}/);
  assert.deepEqual(spec.workers, [{ source: "src/agentAdapters/dshManagerApi.ts", target: "workers/scan.mjs" }]);
});

test("DSH scans resolve their published provider and execute only its owned worker entry", () => {
  const operations = fs.readFileSync(new URL("../../src/agentAdapters/managerNativeOperations.ts", import.meta.url), "utf8");
  const manager = fs.readFileSync(new URL("../../plugins/builtin/io.rabiroute.agent.dsh/1.0.0/manager.mjs", import.meta.url), "utf8");
  assert.match(operations, /invoke\("scan",\s*payload,\s*\{ signal: input\.signal/);
  assert.match(manager, /new URL\(["']\.\/workers\/scan\.mjs["']/);
  assert.match(manager, /scannerExport: ["']scanDshAgentAdapter["']/);
  assert.match(workerPoolSource, /fork\(workerEntryPath\(\)/);
  assert.match(workerPoolSource, /stopChildProcessTree\(worker\)/);
  assert.match(workerSource, /path\.isAbsolute\(task\.entry\)/);
  assert.match(workerSource, /import\(pathToFileURL\(task\.entry\)\.href\)/);
  assert.match(workerSource, /implementation\[task\.exportName/);
  assert.match(workerSource, /return scan\([\s\S]*task\.options\)/);
  assert.doesNotMatch(workerSource, /from ["']\.\.\/agentAdapters\/.*ManagerApi/);
});

test("DSH plugin diagnostics render the live health fields", () => {
  assert.match(pageSource, /v-for="plugin in agentScanFor\(agent\.type\)\?\.plugins \?\? \[\]"/);
  assert.match(pageSource, /plugin\.installed && plugin\.healthy !== false \? 'success' : 'warning'/);
  assert.match(pageSource, /plugin\.healthy === false \? "未就绪" : "已加载"/);
  assert.match(pageSource, /plugin\.details \?\? \[\]/);
});
