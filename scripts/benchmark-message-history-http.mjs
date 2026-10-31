import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

// An isolated HTTP fixture using the production route/service/worker modules.
// Its dynamically assigned address is explicitly injected; this never starts a Manager.
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i + 1] || args.has(process.argv[i])) throw new Error("Invalid capacity argument");
  args.set(process.argv[i], process.argv[i + 1]);
}
const fixture = path.resolve(args.get("--fixture") || "");
const work = path.resolve(args.get("--work") || "");
const build = path.resolve(args.get("--build") || "");
const indexPath = path.resolve(args.get("--index") || "");
const reportPath = path.resolve(args.get("--report") || "");
const count = Number(args.get("--queries") || 10_000);
const qps = Number(args.get("--qps") || 10);
const writes = Number(args.get("--writes") || 0);
const childMode = args.get("--child") === "1";
const sourceMode = args.get("--source-mode") === "1";
if (!["--fixture", "--work", "--build", "--index", "--report"].every(key => args.has(key))
  || !Number.isSafeInteger(count) || count < 1 || count > 100_000 || !Number.isFinite(qps) || qps <= 0 || qps > 100
  || ![0, 100].includes(writes)) throw new Error("Explicit fixture/work/build/index/report and valid load are required");
const marker = JSON.parse(fs.readFileSync(path.join(fixture, "fixture.json"), "utf8"));
if (!marker.synthetic || marker.generator !== "message-search-v1") throw new Error("Unowned synthetic fixture");
const role = path.join(fixture, "synthetic-role");
const indexRelative = path.relative(path.join(fixture, "derived"), indexPath);
const workInRole = path.relative(role, work);
if (!indexRelative || indexRelative.startsWith("..") || path.isAbsolute(indexRelative) || path.dirname(reportPath) !== work
  || (!workInRole.startsWith("..") && !path.isAbsolute(workInRole))) throw new Error("Index/report/work must stay within their owned capacity boundaries");
const currentFile = path.join(role, "conversation/current.jsonl");
const catalogFile = path.join(role, "conversation/archive/index.json");
const hash = buffer => createHash("sha256").update(buffer).digest("hex");
const loadModule = name => import(pathToFileURL(path.join(build, sourceMode ? "src" : "dist", sourceMode ? name.replace(/\.js$/, ".ts") : name)).href);
const progress = event => {
  const item = { at: new Date().toISOString(), pid: process.pid, ...event };
  fs.appendFileSync(path.join(work, "progress.jsonl"), JSON.stringify(item) + "\n");
  process.stdout.write(JSON.stringify(item) + "\n");
};

if (childMode) {
  const { handleMessageEndpointHistoryApi } = await loadModule("manager/messageEndpointHistoryRoutes.js");
  const { queryMessageHistory, stopMessageHistorySearch, messageHistorySearchStatus } = await loadModule("manager/messageHistorySearchService.js");
  const { managerMessageIndexWorkerPool, managerMessageSearchWorkerPool } = await loadModule("manager/managerReadWorkerPool.js");
  const { publishMessageHistoryChange } = await loadModule("messageHistoryChanges.js");
  const { messageHistoryFileVersion, messageHistoryLayoutVersion } = await loadModule("messageHistorySourceVersion.js");
  const { atomicWriteFileSync } = await loadModule("shared/filePersistence.js");
  const { installDataMutationAuditSink } = await loadModule("observability/dataMutationAudit.js");
  const traces = [];
  const removeTraceSink = installDataMutationAuditSink(record => {
    if (["message_history_query", "message_history_response"].includes(record.event) && traces.length < count * 2 + 100) traces.push(record);
  });
  const beforeCurrent = fs.readFileSync(currentFile);
  const beforeCatalog = fs.readFileSync(catalogFile);
  fs.writeFileSync(path.join(work, "current-before.jsonl"), beforeCurrent, { flag: "wx" });
  fs.writeFileSync(path.join(work, "catalog-before.json"), beforeCatalog, { flag: "wx" });
  const catalog = JSON.parse(beforeCatalog);
  const layoutVersion = messageHistoryLayoutVersion(catalog.archives);
  let currentRecords = beforeCurrent.toString("utf8").split("\n").filter(Boolean).length;
  let sequence = catalog.nextSequence;
  let written = 0;
  let feedTimer;
  let feedError;
  let shutdown = false;
  const samples = { maxSearchActive: 0, maxIndexActive: 0, maxQueued: 0 };
  const warmStart = performance.now();
  await managerMessageIndexWorkerPool.run({ type: "message_history_index", roleDir: role, indexPath });
  const coldStart = performance.now();
  await queryMessageHistory(role, { limit: 10, includeArchives: true, query: "任务处理" }, { signal: AbortSignal.timeout(3000), indexPath });
  const firstIndexedQueryMs = performance.now() - coldStart;
  await Promise.all(["任务处理", "not-present-in-synthetic-source"].map(query => queryMessageHistory(role,
    { limit: 10, includeArchives: true, query }, { signal: AbortSignal.timeout(3000), indexPath })));
  const json = (response, status, body) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body));
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://fixture.invalid");
    const handled = handleMessageEndpointHistoryApi(request, url, response, {
      roleDirectory: roleId => { if (roleId !== "synthetic") throw new Error("Unknown fixture role"); return role; }, json,
      queryHistory: (directory, query, options) => queryMessageHistory(directory, query, { ...options, indexPath })
    });
    if (!handled) json(response, 404, { code: -1 });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const timer = setInterval(() => {
    const search = managerMessageSearchWorkerPool.status(); const indexing = managerMessageIndexWorkerPool.status();
    samples.maxSearchActive = Math.max(samples.maxSearchActive, search.active);
    samples.maxIndexActive = Math.max(samples.maxIndexActive, indexing.active);
    samples.maxQueued = Math.max(samples.maxQueued, search.queued);
  }, 1000);
  process.send({ type: "ready", url: `http://127.0.0.1:${server.address().port}`, firstIndexedQueryMs, warmupMs: performance.now() - warmStart });
  process.on("message", async message => {
    if (message.type === "feed" && writes && !feedTimer) {
      const began = performance.now();
      feedTimer = setInterval(() => {
        try {
          const due = Math.min(1000, Math.floor((performance.now() - began) * writes / 1000) - written);
          if (due <= 0) return;
          const before = messageHistoryFileVersion(currentFile); const beforeCatalogStamp = messageHistoryFileVersion(catalogFile); const records = [];
          for (let i = 0; i < due; i++) {
            const id = sequence++;
            records.push(JSON.stringify({ schemaVersion: 1, id: `feed-${id}`, sequence: id, time: 1767225600 + id,
              direction: "inbound", adapter: "synthetic-chat", channel: "synthetic", kind: "group", sender: "feed-sender", target: "feed-target",
              conversationKey: "feed-room", messageId: String(id), text: `任务处理 请求${id % 100 === 0 ? "超时" : "正常"} numeric-${10_000_000 + id} tag-${id % 9973} 😀` }));
          }
          const startedAt = Date.now();
          fs.appendFileSync(currentFile, records.join("\n") + "\n");
          catalog.nextSequence = sequence;
          atomicWriteFileSync(catalogFile, JSON.stringify(catalog));
          publishMessageHistoryChange(role, { before, after: messageHistoryFileVersion(currentFile), previousRecords: currentRecords,
            records: currentRecords + due, layoutVersion, startedAt, committedAt: Date.now(), beforeCatalogStamp, catalogStamp: messageHistoryFileVersion(catalogFile) });
          currentRecords += due; written += due;
        } catch (error) { feedError = String(error.code || "SOURCE_FEED_FAILED"); clearInterval(feedTimer); }
      }, 100);
    }
    if (message.type === "stop" && !shutdown) {
      shutdown = true; clearInterval(feedTimer); clearInterval(timer);
      const searchService = messageHistorySearchStatus(role);
      stopMessageHistorySearch();
      await new Promise(resolve => server.close(resolve));
      await Promise.all([managerMessageSearchWorkerPool.stop(), managerMessageIndexWorkerPool.stop()]);
      removeTraceSink();
      fs.writeFileSync(path.join(work, "query-traces.json"), JSON.stringify(traces));
      if (writes) {
        fs.copyFileSync(currentFile, path.join(work, "current-after-feed.jsonl"));
        atomicWriteFileSync(currentFile, beforeCurrent); atomicWriteFileSync(catalogFile, beforeCatalog);
      }
      const restored = hash(fs.readFileSync(currentFile)) === hash(beforeCurrent) && hash(fs.readFileSync(catalogFile)) === hash(beforeCatalog);
      process.send({ type: "stopped", written, feedError, restored, samples, searchService }, () => process.disconnect());
    }
  });
} else {
  const manifestPath = path.join(build, "compiled-manifest.json");
  const modules = fs.existsSync(manifestPath) && !sourceMode ? Object.keys(JSON.parse(fs.readFileSync(manifestPath, "utf8"))) : ["messageHistorySearchIndex.js", "messageHistorySourceVersion.js", "messageHistoryTail.js", "messageHistoryIndexLifecycle.js",
    "messageHistoryIndexReaders.js", "messageHistoryChanges.js", "messageContextStore.js", "manager/messageHistorySearchService.js",
    "manager/messageHistorySearchTelemetry.js", "manager/messageEndpointHistoryRoutes.js", "manager/managerReadWorker.js",
    "manager/managerReadWorkerTasks.js", "manager/managerReadWorkerPool.js", "manager/managerReadHttpResponse.js"];
  if (modules.some(name => path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || !/\.(js|mjs|json)$/.test(name))) throw new Error("Invalid compiled capacity manifest");
  const moduleManifest = () => Object.fromEntries(modules.map(name => [name, hash(fs.readFileSync(path.join(build,
    sourceMode ? "src" : "dist", sourceMode ? name.replace(/\.js$/, ".ts") : name)))]));
  const modulesAtStart = moduleManifest();
  if (fs.existsSync(work) || fs.existsSync(reportPath)) throw new Error("Refusing to overwrite a capacity run");
  fs.mkdirSync(work, { recursive: true });
  const lock = path.join(fixture, "http-capacity.lock");
  const descriptor = fs.openSync(lock, "wx"); fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, work })); fs.closeSync(descriptor);
  const serverArgs = process.argv.slice(2).concat(["--child", "1"]);
  const child = fork(fileURLToPath(import.meta.url), serverArgs, { execArgv: sourceMode ? ["--import", "tsx"] : [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout.on("data", chunk => fs.appendFileSync(path.join(work, "server-output.log"), chunk));
  child.stderr.on("data", chunk => fs.appendFileSync(path.join(work, "server-error.log"), chunk));
  const nextMessage = type => new Promise((resolve, reject) => {
    const exit = code => { cleanup(); reject(new Error(`Fixture exited before ${type}: ${code}`)); };
    const receive = message => { if (message.type === type) { cleanup(); resolve(message); } };
    const cleanup = () => { child.off("exit", exit); child.off("message", receive); };
    child.on("message", receive); child.once("exit", exit);
  });
  const results = [];
  const agents = Array.from({ length: 4 }, () => new http.Agent({ keepAlive: true, maxSockets: 4 }));
  let done;
  try {
    const ready = await nextMessage("ready");
    const cases = ["10001234", "超时", "任", "任务处理", "tag-9972", "not-present-in-synthetic-source", undefined];
    progress({ phase: "load-start", queries: count, qps, clients: agents.length, writesPerSecond: writes, node: process.version,
      coldIndexedProcessMs: ready.firstIndexedQueryMs, sourceRecords: marker.records });
    if (writes) child.send({ type: "feed" });
    const began = performance.now();
    const flights = new Set();
    const request = (ordinal, scheduledAt) => new Promise(resolve => {
      const sentAt = performance.now(); const query = cases[ordinal % cases.length];
      const url = new URL("/api/roles/synthetic/message-endpoint-history", ready.url);
      url.search = new URLSearchParams({ limit: "10", maxChars: "20000", includeArchives: "1", budgetMs: String(Math.min(3000, Math.max(1, Math.floor(3000 - (sentAt - scheduledAt))))), ...(query ? { query } : {}) }).toString();
      let settled = false;
      const finish = record => {
        if (settled) return; settled = true; clearTimeout(timer);
        results.push({ ordinal, category: ordinal % cases.length, latencyMs: performance.now() - scheduledAt, dispatchLagMs: sentAt - scheduledAt, ...record }); resolve();
      };
      const req = http.get(url, { agent: agents[ordinal % agents.length] }, response => {
        const chunks = []; let bytes = 0;
        response.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) req.destroy(new Error("BODY_LIMIT")); else chunks.push(chunk); });
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks));
            const valid = response.statusCode === 200 && body.code === 0 && typeof body.requestId === "string"
              && Array.isArray(body.data?.entries) && body.data.count === body.data.entries.length
              && body.data.coverage?.sourceSnapshotIndexed === true
              && (ordinal % cases.length === 5 ? body.data.count === 0 : body.data.count > 0 && body.data.count <= 10);
            finish({ ok: valid, status: response.statusCode, error: valid ? undefined : body.errorCode || "INVALID_RESPONSE",
              failureMessage: valid ? undefined : body.message, requestId: body.requestId, count: body.data?.count, bytes });
          } catch { finish({ ok: false, status: response.statusCode, error: "INVALID_JSON" }); }
        });
        response.on("error", () => finish({ ok: false, error: "RESPONSE_ERROR" }));
      });
      const timer = setTimeout(() => req.destroy(new Error("CLIENT_DEADLINE")), Math.max(1, 3000 - (performance.now() - scheduledAt)));
      req.on("error", error => finish({ ok: false, error: error.message === "CLIENT_DEADLINE" ? "CLIENT_DEADLINE" : "TRANSPORT_ERROR" }));
    });
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const scheduledAt = began + ordinal * 1000 / qps;
      const wait = scheduledAt - performance.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      const promise = request(ordinal, scheduledAt); flights.add(promise); promise.finally(() => flights.delete(promise));
      if (ordinal && ordinal % 1000 === 0) progress({ phase: "load-progress", sent: ordinal, completed: results.length, failures: results.filter(item => !item.ok).length });
    }
    await Promise.all(flights);
    const stopped = nextMessage("stopped"); child.send({ type: "stop" }); done = await stopped;
    const elapsedMs = performance.now() - began;
    const percentile = (rows, key, p) => { const values = rows.map(row => row[key]).sort((a, b) => a - b); return values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null; };
    const errors = {};
    for (const row of results) if (!row.ok) errors[row.error || "UNKNOWN"] = (errors[row.error || "UNKNOWN"] || 0) + 1;
    const summary = { requested: count, completed: results.length, successes: results.filter(row => row.ok).length,
      p50: percentile(results, "latencyMs", .5), p95: percentile(results, "latencyMs", .95), p99: percentile(results, "latencyMs", .99), max: percentile(results, "latencyMs", 1),
      dispatchP99: percentile(results, "dispatchLagMs", .99), errors, elapsedMs, written: done.written, measuredSourceWritesPerSecond: done.written * 1000 / elapsedMs };
    const categories = Object.fromEntries(["numeric_substring", "two_char_cjk", "single_char_cjk", "multi_char_cjk", "selective_tag", "zero_hit", "latest"].map((name, category) => {
      const rows = results.filter(row => row.category === category);
      return [name, { completed: rows.length, successes: rows.filter(row => row.ok).length,
        p50: percentile(rows, "latencyMs", .5), p95: percentile(rows, "latencyMs", .95), p99: percentile(rows, "latencyMs", .99), max: percentile(rows, "latencyMs", 1) }];
    }));
    const modulesAtEnd = moduleManifest(); const buildUnchanged = JSON.stringify(modulesAtStart) === JSON.stringify(modulesAtEnd);
    const passed = !sourceMode && buildUnchanged && ready.firstIndexedQueryMs <= 2500 && count >= 10_000 && results.length === count && summary.successes / count >= .999 && summary.p95 <= 500 && summary.p99 <= 1500
      && summary.max <= 3100 && done.restored && !done.feedError && (!writes || summary.measuredSourceWritesPerSecond >= 98);
    const report = { benchmark: "isolated-production-history-http-open-loop", acceptance: passed, installedManagerAcceptance: false,
      coldOsCacheControlled: false, input: { records: marker.records, queries: count, qps, clients: 4, writesPerSecond: writes,
        feed: "committed synthetic source batches; not the business append API throughput" },
      runtime: { node: process.version, productionBuild: !sourceMode, cpu: os.cpus()[0]?.model, cores: os.cpus().length, totalMemory: os.totalmem(),
        moduleHash: modulesAtStart["messageHistorySearchIndex.js"], benchmarkHash: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
        diagnosticsCaptured: true, buildUnchanged, modulesAtStart, modulesAtEnd },
      firstIndexedQueryMs: ready.firstIndexedQueryMs, summary, categories, fixture: done, results };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
    progress({ phase: "complete", acceptance: passed, summary, report: reportPath });
  } finally {
    for (const agent of agents) agent.destroy();
    if (child.connected && !done) child.send({ type: "stop" });
    // Preserve the lock if the child has not confirmed restoration.
    if (done?.restored) fs.unlinkSync(lock);
  }
}
