import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultPerformanceMonitoringConfig, type PerformanceSample } from "../shared/performanceContract.js";
import { PersonaSyncService } from "../personaSync.js";
import { createRecentMemory } from "../roleKnowledge.js";
import { ManagerReadWorkerError, ManagerReadWorkerPool } from "./managerReadWorkerPool.js";
import { PerformanceStore } from "./performanceStore.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function voiceArchiveFixture(archiveCount = 8, entriesPerArchive = 500): string {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-read-worker-"));
  const conversationDir = path.join(roleDir, "conversation");
  const archiveDir = path.join(conversationDir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(conversationDir, "current.jsonl"), "", "utf8");
  const archives: Array<Record<string, unknown>> = [];
  let sequence = 1;
  for (let archiveIndex = 0; archiveIndex < archiveCount; archiveIndex += 1) {
    const firstSequence = sequence;
    const rows: string[] = [];
    for (let rowIndex = 0; rowIndex < entriesPerArchive; rowIndex += 1) {
      const time = Date.UTC(2026, 0, 1 + archiveIndex, 0, 0, rowIndex) / 1_000;
      rows.push(JSON.stringify({
        schemaVersion: 1,
        sequence,
        recordedAt: new Date(time * 1_000).toISOString(),
        time,
        direction: "inbound",
        adapter: "speech",
        kind: "asr",
        text: `voice-${sequence}`,
        voiceprintId: `voiceprint-${sequence % 4}`
      }));
      sequence += 1;
    }
    const lastSequence = sequence - 1;
    const file = `${firstSequence}~${lastSequence}.jsonl`;
    fs.writeFileSync(path.join(archiveDir, file), `${rows.join("\n")}\n`, "utf8");
    archives.push({
      file,
      startedAt: JSON.parse(rows[0]!).recordedAt,
      endedAt: JSON.parse(rows[rows.length - 1]!).recordedAt,
      entryCount: rows.length,
      firstSequence,
      lastSequence
    });
  }
  fs.writeFileSync(path.join(archiveDir, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    nextSequence: sequence,
    archives
  }, null, 2)}\n`, "utf8");
  return roleDir;
}

test("manager read workers keep the main event loop responsive during archive queries", async () => {
  const roleDir = voiceArchiveFixture();
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const result = await pool.queryPersonaVoiceTranscripts(roleDir, {
      includeArchives: true,
      includeDetails: false,
      limit: 200
    });
    assert.equal(result.matchedCount, 4_000);
    assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
  } finally {
    clearInterval(timer);
  }
});

test("manager read workers reject excess heavy reads instead of growing an unbounded queue", async () => {
  const roleDir = voiceArchiveFixture(4, 250);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 0, timeoutMs: 30_000 });
  const first = pool.queryPersonaVoiceTranscripts(roleDir, { includeArchives: true, includeDetails: true });
  await assert.rejects(
    pool.queryPersonaVoiceTranscripts(roleDir, { includeArchives: true, includeDetails: true }),
    (error: unknown) => error instanceof ManagerReadWorkerError && error.code === "busy"
  );
  await first;
});

test("manager read worker pools leave one low-priority slot available beside a long agent scan", async () => {
  const roleDir = voiceArchiveFixture(6, 400);
  const pools = Array.from({ length: 3 }, () => new ManagerReadWorkerPool({
    maxConcurrency: 1,
    maxQueue: 1,
    timeoutMs: 30_000
  }));
  const tasks = pools.map(pool => pool.queryPersonaVoiceTranscripts(roleDir, {
    includeArchives: true,
    includeDetails: true,
    limit: 200
  }));
  const statuses = pools.map(pool => pool.status());
  await Promise.all(tasks);
  assert.equal(statuses.reduce((sum, status) => sum + status.active, 0), 2);
  assert.equal(statuses.reduce((sum, status) => sum + status.queued, 0), 1);
  assert.equal(statuses[0].globalActive, 2);
  assert.equal(statuses[0].globalMaxConcurrency, 2);
});

test("manager read workers coalesce simultaneous voice-summary scans", async () => {
  const roleDir = voiceArchiveFixture(6, 400);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 0, timeoutMs: 30_000 });
  const first = pool.queryPersonaVoiceTranscripts(roleDir, {
    includeArchives: true,
    includeDetails: false,
    from: 0,
    limit: 200
  });
  const second = pool.queryPersonaVoiceTranscripts(roleDir, {
    includeArchives: true,
    includeDetails: false,
    from: 0,
    limit: 50
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.matchedCount, 2_400);
  assert.deepEqual(secondResult, firstResult);
});

test("manager read workers keep conflict-history scans off the main event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-conflict-worker-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const stateRoot = path.join(root, "sync-state");
  fs.mkdirSync(roleRoot, { recursive: true });
  fs.writeFileSync(path.join(roleRoot, "persona.md"), "local divergent\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, stateRoot);
  const conflict = service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote divergent\n").toString("base64"),
    baseHash: hash("base\n"),
    peerId: "pc-b"
  });
  const original = path.join(stateRoot, conflict.conflictPath!);
  const directory = path.dirname(original);
  for (let index = 0; index < 500; index += 1) {
    const duplicate = path.join(directory, `legacy-${String(index).padStart(4, "0")}-${path.basename(original)}`);
    fs.copyFileSync(original, duplicate);
    fs.copyFileSync(`${original}.meta.json`, `${duplicate}.meta.json`);
  }

  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const conflicts = await pool.queryPersonaSyncConflicts(rolesRoot, stateRoot, "Rabi");
    assert.equal(conflicts.length, 1);
    assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
  } finally {
    clearInterval(timer);
  }
});

test("manager read workers keep recent-memory detail scans and viewedAt writes off the main event loop", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-memory-worker-"));
  for (let index = 0; index < 600; index += 1) {
    createRecentMemory(roleDir, {
      id: `memory-${String(index).padStart(4, "0")}`,
      title: `性能记忆 ${index}`,
      focus: `验证近期记忆 ${index} 的读取性能`,
      content: "x".repeat(3_500),
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      keywords: ["性能"]
    });
  }

  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const memory = await pool.queryRecentMemoryDetail(roleDir, "memory-0599");
    assert.equal(memory?.id, "memory-0599");
    assert.equal(typeof memory?.viewedAt, "string");
    assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
  } finally {
    clearInterval(timer);
  }
});

test("manager read workers reuse a resident worker across sequential memory reads", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-memory-worker-reuse-"));
  createRecentMemory(roleDir, {
    id: "memory-reuse",
    title: "常驻 Worker",
    focus: "验证连续读取不会重复启动 Worker",
    content: "worker reuse",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    keywords: ["性能"]
  });
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  try {
    assert.equal((await pool.queryRecentMemoryDetail(roleDir, "memory-reuse"))?.id, "memory-reuse");
    assert.equal((await pool.queryRecentMemoryDetail(roleDir, "missing-memory")), null);
    assert.equal(pool.status().workers, 1);
    assert.equal(pool.status().spawnedWorkers, 1);
  } finally {
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager heavy reads run in a separate low-priority process", async () => {
  const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-read-process-"));
  createRecentMemory(roleDir, {
    id: "memory-process",
    title: "独立进程",
    focus: "验证重任务不与 Manager 共享进程",
    content: "separate process",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    keywords: ["性能"]
  });
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  try {
    assert.equal((await pool.queryRecentMemoryDetail(roleDir, "memory-process"))?.id, "memory-process");
    const status = pool.status();
    assert.equal(status.executionMode, "child_process");
    assert.equal(status.workerPids.length, 1);
    assert.notEqual(status.workerPids[0], process.pid);
    assert.equal(os.getPriority(status.workerPids[0]), os.constants.priority.PRIORITY_BELOW_NORMAL);
  } finally {
    fs.rmSync(roleDir, { recursive: true, force: true });
  }
});

test("manager read workers build performance summaries and JSON outside the main event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-manager-performance-worker-"));
  const config = { ...defaultPerformanceMonitoringConfig(), enabled: true, retentionHours: 720 };
  const store = new PerformanceStore(root, config);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 30_000 });
  try {
    await store.start();
    const baseTime = Date.now() - 3_000 * 5_000;
    for (let index = 0; index < 3_000; index += 1) {
      const time = new Date(baseTime + index * 5_000).toISOString();
      store.append({
        schemaVersion: 1,
        kind: "performance_sample",
        sampleId: `worker-sample-${index}`,
        time,
        intervalMs: 5_000,
        source: { kind: "manager", id: "manager", runtimeId: "runtime-worker", pid: 1 },
        system: {
          cpuPercent: 1,
          rssBytes: 1_000,
          heapUsedBytes: 500,
          heapTotalBytes: 800,
          externalBytes: 10,
          eventLoopP50Ms: 1,
          eventLoopP95Ms: 2,
          eventLoopMaxMs: 3,
          eventLoopUtilization: 0.1
        }
      } satisfies PerformanceSample);
    }
    await store.flush();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const summaryJson = await pool.queryPerformanceSummaryJson(
        store.logDirectory,
        60 * 60 * 1_000,
        config,
        store.status()
      );
      const logsJson = await pool.queryPerformanceLogsJson(store.logDirectory, 100, store.status());
      const summary = JSON.parse(summaryJson) as { data: { sources: unknown[]; points: unknown[] } };
      const logs = JSON.parse(logsJson) as { data: unknown[] };
      assert.equal(summary.data.sources.length, 1);
      assert.ok(summary.data.points.length > 0);
      assert.equal(logs.data.length, 100);
      assert.equal(pool.status().spawnedWorkers, 1);
      assert.ok(ticks >= 5, `expected the Manager event loop to keep ticking, got ${ticks}`);
    } finally {
      clearInterval(timer);
    }
  } finally {
    await store.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
