import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const workerArgument = "--isolated-plan-api-worker";
const readyPrefix = "RABIROUTE_MANAGER_READY:";
const roleId = "SyntheticBenchmark";
const requestTimeoutMs = 45_000;
type Row = { id: string; title: string; focus: string; status: string; keywords: string[]; updatedAt: string; archiveStatus: string };

if (process.argv.includes(workerArgument)) {
  process.on("message", (message: any) => {
    if (message?.type === "metrics") process.send?.({ id: message.id, cpu: process.cpuUsage(), memory: process.memoryUsage(), resource: process.resourceUsage() });
  });
  const entry = path.join(process.env.RABI_PLAN_API_PACKAGE_ROOT!, "dist/manager/controlPlaneRoutes.js");
  const { startManager } = await import(pathToFileURL(entry).href);
  await startManager();
} else {
  test("isolated real Manager plan and knowledge HTTP baseline", { skip: process.env.RABI_PLAN_API_BENCHMARK !== "1", timeout: 1_200_000 }, async () => {
    const count = Number(process.env.RABI_PLAN_API_COUNT ?? "1000");
    assert.ok(Number.isInteger(count) && count >= 1000 && count <= 100000);
    const packageRoot = process.env.RABI_PLAN_API_PACKAGE_ROOT;
    assert.ok(packageRoot && path.isAbsolute(packageRoot), "explicit built candidate required");
    const entry = path.join(packageRoot, "dist/manager/controlPlaneRoutes.js");
    assert.ok(fs.existsSync(entry));
    const free = fs.statfsSync(os.tmpdir());
    assert.ok(free.bavail * free.bsize > 4 * 1024 ** 3, "4 GiB free required");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-api-benchmark-"));
    const roleRoot = path.join(root, "roles", roleId);
    const reportPath = path.join(root, "report.json");
    const report: any = { count, packageRoot, node: process.version, entrySha256: createHash("sha256").update(fs.readFileSync(entry)).digest("hex"), samples: [], failures: [], resources: [], limitations: ["new process cold, not OS cold cache", "plan-only corpus; no recent/consolidated memory", "unique timestamps; no tie/Unicode/cross-kind collision coverage", "IPC metrics cover Manager only, not child-process workers; worker PIDs retained in meta", "no write-after-read acceptance yet"] };
    const persist = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    let child: ChildProcess | undefined;
    let ready: any;
    let stdout = "", stderr = "";
    const token = randomBytes(32).toString("hex");
    const generation = randomUUID();
    const overallStarted = performance.now();
    function checkBudget() { assert.ok(performance.now() - overallStarted < 1_080_000, "18 minute execution budget exceeded"); }
    async function waitForExit(timeout: number) {
      if (!child || child.exitCode !== null || child.signalCode !== null) return child?.exitCode;
      return new Promise((resolve, reject) => {
        const onExit = (code: number | null) => { clearTimeout(timer); resolve(code); };
        const timer = setTimeout(() => { child!.off("exit", onExit); reject(new Error("test Manager exit timeout")); }, timeout);
        child!.once("exit", onExit);
      });
    }
    async function metrics(stage: string) {
      if (!child?.connected) return;
      const id = randomUUID();
      const value = await new Promise((resolve, reject) => {
        const listener = (message: any) => { if (message.id === id) { clearTimeout(timer); child!.off("message", listener); resolve(message); } };
        const timer = setTimeout(() => { child!.off("message", listener); reject(new Error("metrics timeout")); }, 5000);
        child!.on("message", listener); child!.send({ type: "metrics", id });
      });
      report.resources.push({ stage, value });
    }
    async function request(route: string, phase: string, init?: RequestInit) {
      checkBudget();
      const start = performance.now();
      const sample: any = { phase, route };
      report.samples.push(sample);
      try {
        const response = await fetch(ready.baseUrl + route, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
        const text = await response.text();
        sample.status = response.status; sample.bytes = Buffer.byteLength(text);
        return { status: response.status, body: text ? JSON.parse(text) : null, retryAfter: response.headers.get("retry-after") };
      } catch (error) { sample.error = String(error); throw error; }
      finally { sample.ms = performance.now() - start; }
    }
    async function check(name: string, operation: () => Promise<void>) {
      try { await operation(); } catch (error) { report.failures.push({ name, error: String(error) }); }
      persist();
    }
    try {
      fs.mkdirSync(path.join(roleRoot, "plans/active"), { recursive: true });
      fs.mkdirSync(path.join(roleRoot, "plans/archive"), { recursive: true });
      fs.mkdirSync(path.join(root, "state"), { recursive: true });
      const profile = path.join(root, "profile.json");
      const pluginNames = ["core", "persona", "diagnostics"];
      fs.writeFileSync(profile, JSON.stringify({ schemaVersion: 2,
        readyRequires: pluginNames.map(name => `manager.${name}@1`),
        instances: pluginNames.map(name => ({ id: `manager:${name}`, package: `io.rabiroute.manager.${name}`, version: "1.0.0", enabled: true, config: {}, grants: [] })) }));
      const { ensurePersonaPlanWorkflow } = await import(pathToFileURL(path.join(packageRoot, "dist/personaPlanWorkflow.js")).href);
      const workflow = ensurePersonaPlanWorkflow(roleRoot).workflow;
      const statuses = [workflow.roles.analysis, workflow.roles.execution, workflow.roles.waitingQa];
      assert.ok(statuses.every(item => typeof item === "string"), JSON.stringify(workflow.roles));
      const definitions = new Map<string, any>(workflow.statuses.map((item: any) => [item.key, item]));
      const rows: Row[] = [];
      const sourceHash = createHash("sha256");
      const buildStarted = performance.now();
      let logicalBytes = 0;
      for (let i = 0; i < count; i++) {
        if (i % 500 === 0) checkBudget();
        const id = `synthetic-${String(i).padStart(6, "0")}`;
        const row: Row = { id, title: id, focus: i % 17 === 0 ? "bodyneedle synthetic baseline" : "synthetic baseline", status: statuses[i % statuses.length], keywords: ["synthetic", `tag-${i % 10}`], archiveStatus: "未归档", updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() };
        const plan = { ...row, activationStatus: "进行中", markerStatus: row.status, attachments: [], currentStepId: "step", steps: [{ id: "step", title: "original" }], createdAt: "2026-01-01T00:00:00.000Z" };
        const text = JSON.stringify(plan);
        const history = JSON.stringify({ id: `synthetic-history-${id}`, planId: id, kind: "created", actor: { kind: "unknown" }, recordedAt: plan.updatedAt, after: plan }) + "\n";
        sourceHash.update(text + "\n"); logicalBytes += Buffer.byteLength(text) + Buffer.byteLength(history);
        assert.ok(logicalBytes + (i + 1) * 12288 < 2 * 1024 ** 3, "fixture disk estimate exceeds 2 GiB");
        const directory = path.join(roleRoot, "plans/active", id);
        fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "plan.json"), text);
        fs.writeFileSync(path.join(directory, "history.jsonl"), history); rows.push(row);
      }
      report.fixture = { count: rows.length, logicalBytes, sha256: sourceHash.digest("hex"), buildMs: performance.now() - buildStarted, estimatedAllocationBytes: logicalBytes + count * 12288 };
      persist();
      const started = performance.now();
      child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), workerArgument], {
        cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, NODE_OPTIONS: "", APPDATA: path.join(root, "appdata"), PROGRAMDATA: path.join(root, "programdata"), HOME: path.join(root, "home"), LOCALAPPDATA: path.join(root, "localappdata"), USERPROFILE: path.join(root, "userprofile"), GATEWAY_MANAGER_HOST: "127.0.0.1", GATEWAY_MANAGER_PORT: "0", GATEWAY_MANAGER_URL: "", RABIROUTE_APPLICATION_GENERATION_ID: generation, RABIROUTE_HOST_CONTROL_TOKEN: token, RABIROUTE_HOSTED: "1", RABIROUTE_MANAGER_AUTOSTART: "0", RABIROUTE_MANAGER_READ_ONLY: "0", RABIROUTE_PACKAGE_ROOT: packageRoot, RABI_PLAN_API_PACKAGE_ROOT: packageRoot, RABIROUTE_PLUGIN_PACKAGE_ROOTS: path.join(packageRoot, "dist", "plugins", "packages"), RABIROUTE_PLUGIN_PROFILE: profile, RABIROUTE_STATE_ROOT: path.join(root, "state"), ROLES_DIR: path.join(root, "roles"), ROUTE_DIR: path.join(root, "routes") }
      });
      child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
      ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("READY timeout")), 180_000);
        child!.once("error", error => { clearTimeout(timer); reject(error); });
        child!.once("exit", code => { clearTimeout(timer); reject(new Error(`exit before READY ${code}`)); });
        child!.stdout!.on("data", chunk => {
          stdout += String(chunk);
          if (stdout.length > 16 * 1024 ** 2) { clearTimeout(timer); reject(new Error("log budget exceeded")); return; }
          const line = stdout.split(/\r?\n/).find(value => value.startsWith(readyPrefix) && value.endsWith("}"));
          if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(readyPrefix.length))); }
        });
        child!.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
      });
      report.ready = ready; report.startupMs = performance.now() - started;
      assert.equal(ready.pid, child.pid); assert.equal(ready.applicationGenerationId, generation);
      assert.equal(new URL(ready.baseUrl).hostname, "127.0.0.1");
      const before = await request("/meta", "identity-before"); report.metaBefore = before.body;
      assert.equal(before.status, 200); assert.equal(before.body.managerInstanceId, ready.managerInstanceId); assert.equal(before.body.applicationGenerationId, generation);
      await metrics("before");
      const ordered = [...rows].sort((a, b) => definitions.get(a.status).order - definitions.get(b.status).order || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const frequencies = (values: string[]) => { const result: Record<string, number> = {}; for (const value of values) result[value] = (result[value] ?? 0) + 1; return result; };
      const pageOracles = new Map<string, { expected: Row[]; statusCounts: Record<string, number>; tagCounts: Record<string, number> }>();
      const allStatusCounts = frequencies(rows.map(row => row.status));
      async function page(phase: string, options: Record<string, string> = {}) {
        const oracleKey = JSON.stringify([options.query, options.view, options.status, options.tag, options.sort]);
        let oracle = pageOracles.get(oracleKey);
        if (!oracle) {
          const faceted = ordered.filter(row => (!options.query || row.focus.includes(options.query)) && (!options.view || definitions.get(row.status).views.includes(options.view)));
          let expected = faceted.filter(row => (!options.status || row.status === options.status) && (!options.tag || row.keywords.includes(options.tag)));
          if (options.sort === "updated") expected = [...expected].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          oracle = { expected, statusCounts: frequencies(faceted.map(row => row.status)), tagCounts: frequencies(faceted.flatMap(row => row.keywords)) };
          pageOracles.set(oracleKey, oracle);
        }
        const { expected } = oracle;
        const response = await request(`/api/roles/${roleId}/plans?${new URLSearchParams({ limit: "8", detail: "summary", ...options })}`, phase);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const data = response.body.data;
        const offset = Number(options.cursor ?? 0);
        assert.equal(data.total, expected.length);
        assert.deepEqual(data.items.map((item: any) => item.id), expected.slice(offset, offset + 8).map(row => row.id));
        assert.equal(data.nextCursor, offset + data.items.length < expected.length ? String(offset + data.items.length) : "");
        assert.equal(data.counts.total, count); assert.deepEqual(data.counts.stages.byStatus, allStatusCounts);
        if (options.facets !== "0") {
          assert.deepEqual(Object.fromEntries(data.facets.statuses.map((item: any) => [item.status, item.count])), oracle.statusCounts);
          assert.deepEqual(Object.fromEntries(data.facets.tags.map((item: any) => [item.tag, item.count])), oracle.tagCounts);
        }
      }
      const initializationStarted = performance.now();
      const initializationRoute = `/api/roles/${roleId}/plans?limit=8&detail=summary`;
      let initialization = await request(initializationRoute, "initialization-first");
      let initializationAttempts = 0;
      while (initialization.status === 503 && initialization.body?.reason === "PLAN_CATALOG_INITIALIZING") {
        assert.equal(initialization.retryAfter, "2");
        assert.equal(initialization.body.data, undefined, "initialization must not return fake empty data");
        assert.ok(performance.now() - initializationStarted < 300_000, "initialization budget exceeded");
        await new Promise(resolve => setTimeout(resolve, 2000));
        initialization = await request(initializationRoute, `initialization-${++initializationAttempts}`);
      }
      assert.equal(initialization.status, 200, JSON.stringify(initialization.body));
      report.planAvailableAfterMs = performance.now() - initializationStarted;
      report.planInitializationAttempts = initializationAttempts;
      await check("ready-first-8", () => page("ready-first-8"));
      for (let i = 0; i < 5; i++) await check(`warm-${i}`, () => page(`warm-${i}`));
      const cases: Record<string, Record<string, string>> = { next: { cursor: "8" }, tail: { cursor: String(count - 4) }, query: { query: "bodyneedle" }, status: { status: statuses[1] }, tag: { tag: "tag-3" }, combined: { query: "bodyneedle", status: statuses[1], tag: "tag-3" }, view: { view: "current" }, updated: { sort: "updated" }, noFacets: { facets: "0" } };
      for (const [name, options] of Object.entries(cases)) await check(name, () => page(name, options));
      for (const concurrency of [2, 6, 20]) await check(`concurrency-${concurrency}`, async () => {
        const began = performance.now();
        const results = await Promise.allSettled(Array.from({ length: concurrency }, (_, i) => page(`concurrency-${concurrency}-${i}`, { cursor: String(i * 8) })));
        report[`concurrency${concurrency}WallMs`] = performance.now() - began;
        for (const result of results) if (result.status === "rejected") throw result.reason;
      });
      // Keep correctness and latency gates separate: a successful HTTP response
      // is not evidence that the ready-state service objective was met.
      const latencyGroups: Record<string, number[]> = {};
      for (const [name, options] of Object.entries({ ordinary: {}, ...cases })) {
        const prefix = `latency-${name}-`;
        for (let round = 0; round < 5; round++) {
          await check(`${prefix}batch-${round}`, async () => {
            const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
              page(`${prefix}${round}-${i}`, { ...options, cursor: String(Number(options.cursor ?? 0) + i * 8) })));
            for (const result of results) if (result.status === "rejected") throw result.reason;
          });
        }
        const samples = report.samples.filter((sample: any) => sample.phase.startsWith(prefix));
        const values = samples.map((sample: any) => sample.ms as number).sort((a: number, b: number) => a - b);
        latencyGroups[name] = values;
        await check(`${prefix}objective`, async () => {
          assert.equal(samples.length, 100);
          assert.ok(samples.every((sample: any) => sample.status === 200 && !sample.error));
          assert.ok(values[94] <= 300, `${name} p95 ${values[94]} ms exceeds 300 ms`);
          assert.ok(values[98] <= 1000, `${name} p99 ${values[98]} ms exceeds 1000 ms`);
        });
      }
      report.readyLatency = Object.fromEntries(Object.entries(latencyGroups).map(([name, values]) =>
        [name, { count: values.length, concurrency: 20, p95Ms: values[94], p99Ms: values[98], maxMs: values.at(-1) }]));
      for (const mode of ["keywords", "fulltext"]) await check(`knowledge-${mode}`, async () => {
        const query = mode === "keywords" ? "tag-3" : "bodyneedle";
        const expected = rows.filter(row => mode === "keywords" ? row.keywords.includes(query) : row.focus.includes(query)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const route = `/api/roles/${roleId}/knowledge/search?${new URLSearchParams({ mode, query, kind: "plan", limit: "8" })}`;
        const began = performance.now(); let response = await request(route, `knowledge-${mode}-cold`); let attempt = 0;
        while (response.status === 503 && response.body?.message === "KNOWLEDGE_INDEX_WARMING" && performance.now() - began < 300_000) {
          await new Promise(resolve => setTimeout(resolve, Math.min(5000, 250 * 2 ** Math.min(attempt++, 5))));
          response = await request(route, `knowledge-${mode}-warming-${attempt}`);
        }
        report[`knowledge${mode}AvailableAfterMs`] = performance.now() - began;
        for (let i = 0; i < 5; i++) {
          if (i) response = await request(route, `knowledge-${mode}-warm-${i}`);
          assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.data.total, expected.length);
          assert.deepEqual(response.body.data.items.map((item: any) => item.id), expected.slice(0, 8).map(row => row.id));
        }
      });
      report.knowledgeStatus = (await request(`/api/roles/${roleId}/knowledge/cache/status`, "knowledge-status")).body;
      await metrics("after");
      report.metaAfter = (await request("/meta", "identity-after")).body;
      assert.equal(report.metaAfter.applicationGenerationId, generation); assert.equal(report.metaAfter.managerInstanceId, ready.managerInstanceId);
    } catch (error) { report.failures.push({ name: "setup", error: error instanceof Error ? error.stack : String(error) }); }
    finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          assert.ok(ready, "no READY for graceful shutdown");
          const response = await fetch(ready.baseUrl + "/_rabiroute/host/shutdown", { method: "POST", headers: { "x-rabiroute-host-token": token }, signal: AbortSignal.timeout(5000) });
          assert.equal(response.status, 202); report.exitCode = await waitForExit(15_000); assert.equal(report.exitCode, 0);
        } catch (error) { report.failures.push({ name: "shutdown", error: String(error) }); child.kill("SIGKILL"); await waitForExit(5000).catch(() => undefined); }
      }
      fs.writeFileSync(path.join(root, "manager.stdout.log"), stdout); fs.writeFileSync(path.join(root, "manager.stderr.log"), stderr);
      report.passed = report.failures.length === 0; report.finishedAt = new Date().toISOString();
      persist(); console.log(JSON.stringify({ reportPath, count, passed: report.passed, failures: report.failures }));
    }
    assert.equal(report.failures.length, 0, reportPath);
  });
}
