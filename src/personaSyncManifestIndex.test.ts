import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "./personaSync.js";
import {
  PersonaSyncManifestIndex,
  type PersonaSyncManifestIndexEvent
} from "./personaSyncManifestIndex.js";

function fixture(fileCount = 3): { root: string; rolesRoot: string; roleRoot: string; stateRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-index-"));
  const rolesRoot = path.join(root, "roles");
  const roleRoot = path.join(rolesRoot, "Rabi");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(path.join(roleRoot, "memory"), { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    fs.writeFileSync(path.join(roleRoot, "memory", `${index}.md`), `memory-${index}\n`, "utf8");
  }
  return { root, rolesRoot, roleRoot, stateRoot };
}

function writeCanonicalActivePlan(roleRoot: string, planId: string): string[] {
  const directory = path.join(roleRoot, "plans", "active", planId);
  const recordedAt = "2026-08-31T00:00:00.000Z";
  const plan = { id: planId, title: planId, focus: planId, status: "执行中", updatedAt: recordedAt };
  const history = {
    id: `history-${planId}`,
    planId,
    kind: "created",
    recordedAt,
    after: plan
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "plan.json"), `${JSON.stringify(plan)}\n`, "utf8");
  fs.writeFileSync(path.join(directory, "history.jsonl"), `${JSON.stringify(history)}\n`, "utf8");
  return [
    `plans/active/${planId}/history.jsonl`,
    `plans/active/${planId}/plan.json`
  ];
}

function oneShotEvent(
  predicate: (event: PersonaSyncManifestIndexEvent) => boolean,
  timeoutMs = 5_000
): { promise: Promise<PersonaSyncManifestIndexEvent>; observe(event: PersonaSyncManifestIndexEvent): void } {
  let settled = false;
  let resolveEvent: (event: PersonaSyncManifestIndexEvent) => void = () => undefined;
  let rejectEvent: (error: Error) => void = () => undefined;
  const promise = new Promise<PersonaSyncManifestIndexEvent>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectEvent(new Error("Timed out waiting for the persona manifest file event."));
  }, timeoutMs);
  return {
    promise,
    observe(event): void {
      if (settled || !predicate(event)) return;
      settled = true;
      clearTimeout(timer);
      resolveEvent(event);
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for the persona manifest index condition.");
}

test("persona manifest index survives a transient persistence failure and retries the rebuildable cache", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  let persistAttempts = 0;
  const service = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false,
    persistSettleMs: 5,
    persistRetryBaseMs: 5,
    persistRetryMaxMs: 20,
    writePersistedIndex: (filePath, content) => {
      persistAttempts += 1;
      if (persistAttempts === 1) {
        const error = new Error("injected SMB rename interruption") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  });
  t.after(() => service.stopManifestIndex());

  const manifest = await service.manifest("Rabi");
  assert.equal(manifest.roles[0]?.files.length, 3);
  await waitFor(() => persistAttempts >= 2);

  const status = service.manifestIndexStatus();
  assert.equal(status.state, "ready");
  assert.equal(status.persistence?.consecutiveFailures, 0);
  assert.equal(status.persistence?.totalFailures, 1);
  assert.ok(status.persistence?.lastPersistedAt);
  assert.equal(status.persistence?.lastError, undefined);
});

test("persona manifest index persists hashes and reuses them after restart", async (t) => {
  const data = fixture(128);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const first = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false
  });
  const firstManifest = await first.manifest("Rabi");
  assert.equal(firstManifest.roles[0]?.files.length, 128);
  assert.equal(first.manifestIndexStatus().lastReconcile?.hashedFiles, 128);
  first.stopManifestIndex();

  const indexPath = path.join(data.stateRoot, "manifest-index.json");
  const persisted = fs.readFileSync(indexPath, "utf8");
  assert.equal(persisted.includes(data.root), false);
  assert.equal(persisted.includes("memory-0"), false);

  const second = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false
  });
  t.after(() => second.stopManifestIndex());
  const secondManifest = await second.manifest("Rabi");
  assert.equal(secondManifest.roles[0]?.files.length, 128);
  assert.equal(second.manifestIndexStatus().lastReconcile?.hashedFiles, 0);
  assert.equal(second.manifestIndexStatus().lastReconcile?.reusedFiles, 128);
});

test("read-only persona manifest uses the persisted snapshot without walking an unavailable NAS root", async (t) => {
  const data = fixture(4);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const seed = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false
  });
  await seed.manifest("Rabi");
  seed.stopManifestIndex();
  fs.renameSync(data.rolesRoot, `${data.rolesRoot}-offline`);

  const readOnly = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    readOnly: true,
    watch: false,
    reconcileOnQueryFallback: false
  });
  t.after(() => readOnly.stopManifestIndex());
  const startedAt = Date.now();
  const manifest = await readOnly.manifest("Rabi");
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(manifest.roles[0]?.files.length, 4);
  assert.equal(readOnly.manifestIndexStatus().lastReconcile, undefined);
});

test("persona manifest excludes work-cycle runtime state while preserving portable persona knowledge", async (t) => {
  const data = fixture(0);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const portableFiles = new Map([
    ["persona.md", "# Rabi\n"],
    ["memory/recent/memory-1.json", "{\"id\":\"memory-1\"}\n"]
  ]);
  const runtimeFiles = new Map([
    ["state/work-cycle-history/snapshot.json", "{\"records\":[]}\n"],
    ["state/work-cycle-history-locks/digest.lock", "{\"pid\":1}\n"],
    ["state/work-cycle-plan-locks/plan-1/owner.json", "{\"pid\":1}\n"],
    ["state/work-cycle-receipt-locks/receipt.lock.json", "{\"pid\":1}\n"],
    ["conversation/situations/situation-1.json", "{\"schemaVersion\":1}\n"],
    ["tmp/persona-sync-upload.json", "{\"temporary\":true}\n"],
    ["plans/items/active/plan-1.json.tmp", "temporary\n"],
    ["memory/recent/memory-1.json.lock", "locked\n"],
    ["memory/recent/memory-1.json.part", "partial\n"]
  ]);
  for (const [relativePath, content] of [...portableFiles, ...runtimeFiles]) {
    const target = path.join(data.roleRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  const canonicalPlanFiles = writeCanonicalActivePlan(data.roleRoot, "plan-1");

  const service = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false
  });
  t.after(() => service.stopManifestIndex());
  const files = (await service.manifest("Rabi")).roles[0]?.files.map(file => file.path) ?? [];

  assert.deepEqual(files, [...portableFiles.keys(), ...canonicalPlanFiles].sort());
  for (const relativePath of runtimeFiles.keys()) assert.equal(files.includes(relativePath), false);
});

test("persona manifest index hashes one changed file from a filesystem event", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const seed = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false
  });
  await seed.manifest("Rabi");
  seed.stopManifestIndex();

  const changed = oneShotEvent(event =>
    event.kind === "updated" && event.roleId === "Rabi" && event.path === "memory/1.md"
  );
  const service = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: true,
    onEvent: event => changed.observe(event)
  });
  t.after(() => service.stopManifestIndex());
  await service.startManifestIndex();
  if (service.manifestIndexStatus().watchMode !== "recursive") {
    t.skip("Recursive filesystem events are unavailable on this runtime.");
    return;
  }
  const beforeHash = (await service.manifest("Rabi")).roles[0]?.files.find(file => file.path === "memory/1.md")?.sha256;
  const beforeCount = service.manifestIndexStatus().totalHashedFiles;
  fs.writeFileSync(path.join(data.roleRoot, "memory", "1.md"), "changed-memory-one\n", "utf8");
  const manifestPromise = service.manifest("Rabi");
  await changed.promise;
  const manifest = await manifestPromise;
  const afterHash = manifest.roles[0]?.files.find(file => file.path === "memory/1.md")?.sha256;
  assert.notEqual(afterHash, beforeHash);
  assert.equal(service.manifestIndexStatus().totalHashedFiles - beforeCount, 1);
});

test("persona manifest directory events reconcile only the changed subtree", async (t) => {
  const data = fixture(40);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  for (let index = 0; index < 60; index += 1) {
    writeCanonicalActivePlan(data.roleRoot, `plan-${index}`);
  }

  const index = new PersonaSyncManifestIndex(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false
  });
  t.after(() => index.stop());
  await index.start();
  assert.equal(index.status().files, 160);

  fs.rmSync(path.join(data.roleRoot, "memory", "0.md"));
  index.notePathChanged("Rabi", "memory");
  await waitFor(() => index.status().lastReconcile?.reason === "directory_event");
  assert.equal(index.status().lastReconcile?.reusedFiles, 39);
  assert.equal(index.status().files, 159);
  const manifest = await index.manifest("Rabi");
  const files = manifest.roles[0]?.files.map(file => file.path) ?? [];

  assert.equal(index.status().lastReconcile?.reason, "authoritative_plan_manifest_query");
  assert.equal(index.status().files, 159);
  assert.equal(files.includes("memory/0.md"), false);
  assert.equal(files.includes("plans/active/plan-59/plan.json"), true);
});

test("persona manifest stops unreliable watching when Windows omits the changed path", async (t) => {
  const data = fixture(12);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  let listener: ((eventType: fs.WatchEventType, filename: string | Buffer | null) => void) | undefined;
  const watcher = new EventEmitter() as fs.FSWatcher;
  watcher.close = () => undefined;
  watcher.unref = () => watcher;
  const events: PersonaSyncManifestIndexEvent[] = [];
  const index = new PersonaSyncManifestIndex(() => data.rolesRoot, data.stateRoot, {
    watch: true,
    watchFactory: (_root, callback) => {
      listener = callback;
      return watcher;
    },
    onEvent: event => events.push(event)
  });
  t.after(() => index.stop());
  await index.start();
  const before = index.status();
  assert.equal(before.watchMode, "recursive");

  listener?.("change", null);

  const after = index.status();
  assert.equal(after.state, "fallback");
  assert.equal(after.watchMode, "query_reconcile");
  assert.equal(after.totalHashedFiles, before.totalHashedFiles);
  assert.equal(after.lastReconcile?.reason, "post_watch");
  assert.equal(events.at(-1)?.kind, "watch_unavailable");
});

test("persona manifest watcher ignores runtime history events but observes portable knowledge changes", async (t) => {
  const data = fixture(0);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(data.roleRoot, "state", "work-cycle-history"), { recursive: true });
  const service = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, { watch: true });
  t.after(() => service.stopManifestIndex());
  await service.startManifestIndex();
  if (service.manifestIndexStatus().watchMode !== "recursive") {
    t.skip("Recursive filesystem events are unavailable on this runtime.");
    return;
  }
  const before = service.manifestIndexStatus();
  fs.writeFileSync(
    path.join(data.roleRoot, "state", "work-cycle-history", "runtime.json"),
    "{\"runtime\":true}\n",
    "utf8"
  );
  const afterRuntime = await service.manifest("Rabi");
  assert.equal(afterRuntime.roles[0]?.files.some(file => file.path.includes("work-cycle-history")), false);
  assert.equal(service.manifestIndexStatus().generation, before.generation);
  assert.equal(service.manifestIndexStatus().totalHashedFiles, before.totalHashedFiles);

  writeCanonicalActivePlan(data.roleRoot, "plan-1");
  const afterPortable = await service.manifest("Rabi");
  assert.equal(afterPortable.roles[0]?.files.some(file => file.path === "plans/active/plan-1/plan.json"), true);
  assert.ok(service.manifestIndexStatus().generation > before.generation);
  assert.equal(service.manifestIndexStatus().totalHashedFiles, before.totalHashedFiles + 2);
});

test("persona manifest keeps function with one-shot query reconciliation when events are disabled", async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const service = new PersonaSyncService(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: true
  });
  t.after(() => service.stopManifestIndex());
  const before = await service.manifest("Rabi");
  assert.equal(before.roles[0]?.files.length, 3);
  fs.writeFileSync(path.join(data.roleRoot, "memory", "added.md"), "fallback\n", "utf8");
  const after = await service.manifest("Rabi");
  assert.equal(after.roles[0]?.files.some(file => file.path === "memory/added.md"), true);
  assert.equal(service.manifestIndexStatus().watchMode, "disabled");
  assert.equal(service.manifestIndexStatus().lastReconcile?.reason, "query_fallback");
});

test("child-process manifest refresh atomically publishes a deeply immutable snapshot", async (t) => {
  const data = fixture(2);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const index = new PersonaSyncManifestIndex(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false,
    scanExecutionMode: "child_process",
    refreshTimeoutMs: 5_000
  });
  t.after(() => index.stop());

  await index.start();

  const published = index.publishedSnapshot("Rabi");
  assert.equal(published.publication.executionMode, "child_process");
  assert.equal(published.publication.available, true);
  assert.equal(published.publication.revision, 1);
  assert.equal(published.publication.state, "ready");
  assert.equal(published.publication.stale, false);
  assert.ok(published.publication.refreshedAt);
  assert.ok(published.manifest);
  assert.equal(Object.isFrozen(published.manifest), true);
  assert.equal(Object.isFrozen(published.manifest!.roles), true);
  assert.equal(Object.isFrozen(published.manifest!.roles[0]), true);
  assert.equal(Object.isFrozen(published.manifest!.roles[0].files), true);
  assert.equal(Object.isFrozen(published.manifest!.roles[0].files[0]), true);
  assert.deepEqual(published.manifest!.roles[0].files.map(file => file.path), ["memory/0.md", "memory/1.md"]);
});

test("child-process manifest refresh runs one trailing scan when a file event arrives in flight", async (t) => {
  const data = fixture(0);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  let workerRuns = 0;
  let releaseFirstRun: (() => void) | undefined;
  const firstRunBlocked = new Promise<void>(resolve => { releaseFirstRun = resolve; });
  const result = () => ({
    schemaVersion: 1 as const,
    cache: {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      roles: [],
      files: []
    },
    scan: { hashedFiles: 0, reusedFiles: 0, completedAt: new Date().toISOString() }
  });
  const index = new PersonaSyncManifestIndex(() => data.rolesRoot, data.stateRoot, {
    watch: false,
    reconcileOnQueryFallback: false,
    scanExecutionMode: "child_process",
    runManifestWorker: async () => {
      workerRuns += 1;
      if (workerRuns === 1) await firstRunBlocked;
      return result();
    }
  });
  t.after(() => index.stop());

  const started = index.start();
  await waitFor(() => workerRuns === 1);
  index.notePathChanged("Rabi", "memory/added.md");
  await new Promise(resolve => setTimeout(resolve, 120));
  releaseFirstRun?.();
  await started;

  assert.equal(workerRuns, 2);
  assert.equal(index.status().lastReconcile?.reason, "file_event");
  assert.equal(index.status().publication.revision, 2);
});

test("UNC persona roots never reach Manager fs.watch and use the single child refresh loop", async (t) => {
  const data = fixture(0);
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  let workerRuns = 0;
  let watchCalls = 0;
  const events: PersonaSyncManifestIndexEvent[] = [];
  const index = new PersonaSyncManifestIndex(
    () => "\\\\example-host\\example-share\\project\\data\\roles",
    data.stateRoot,
    {
      watch: true,
      scanExecutionMode: "child_process",
      remoteRefreshIntervalMs: 250,
      onEvent: event => events.push(event),
      watchFactory: () => {
        watchCalls += 1;
        throw new Error("UNC paths must never reach fs.watch.");
      },
      runManifestWorker: async () => {
        workerRuns += 1;
        return {
          schemaVersion: 1,
          cache: {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            roles: [],
            files: []
          },
          scan: { hashedFiles: 0, reusedFiles: 0, completedAt: new Date().toISOString() }
        };
      }
    }
  );
  t.after(() => index.stop());

  await index.start();
  await waitFor(() => workerRuns >= 2, 1_000);

  assert.equal(watchCalls, 0);
  assert.equal(index.status().watchMode, "worker_poll");
  assert.equal(index.status().state, "ready");
  assert.equal(index.status().error, undefined);
  assert.equal(index.status().publication.state, "ready");
  assert.equal(index.status().publication.stale, false);
  assert.equal(events.some(event => event.kind === "watch_unavailable"), false);
  assert.ok(workerRuns >= 2);
});
