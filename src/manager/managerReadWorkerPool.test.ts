import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "../personaSync.js";
import { ManagerReadWorkerError, ManagerReadWorkerPool } from "./managerReadWorkerPool.js";

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
