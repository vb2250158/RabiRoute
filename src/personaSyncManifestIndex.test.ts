import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "./personaSync.js";
import type { PersonaSyncManifestIndexEvent } from "./personaSyncManifestIndex.js";

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
