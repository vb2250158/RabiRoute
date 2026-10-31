import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import { AsyncPluginOutcomeArchive, OutcomeFirstUnavailableError, outcomeKey } from "./asyncOutcomeArchive.js";
import type { FileHandle } from "node:fs/promises";

const identity: PluginIdentity = { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager", activationId: "fixture-activation", instanceId: "fixture-instance", pluginId: "org.example.fixture", version: "1.0.0", revision: "fixture-revision", host: "manager" };

test("running and normal successful reservations create no archive or fsync", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "outcome-zero-io-"));
  const archive = new AsyncPluginOutcomeArchive(path.join(root, "archive"));
  try {
    const release = archive.reserve(identity, "ordinary-call", "unknown");
    await archive.observe({ identity, requestId: "ordinary-call", receipt: { requestId: "ordinary-call", executionOutcome: "running", effectOutcome: "unknown", uncertaintyObserved: false } });
    release();
    assert.equal(archive.snapshot().writes, 0); assert.equal(archive.snapshot().pending, 0); assert.equal(archive.snapshot().reservations, 0);
    await assert.rejects(fs.stat(archive.root), { code: "ENOENT" });
  } finally { await archive.dispose(); await fs.rm(root, { recursive: true }); }
});

test("failed archive retains the same pending actual join and resolves it after owned repair", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "outcome-late-join-"));
  const archive = new AsyncPluginOutcomeArchive(path.join(root, "archive"), { hotLimit: 2, pendingLimitPerPlugin: 1 });
  const requestId = "original-request", release = archive.reserve(identity, requestId, "mutation");
  await fs.writeFile(archive.root, "fixture-only block");
  let confirmed = false;
  const actual = archive.observe({ identity, requestId, firstFailure: { code: "ORIGINAL_UNKNOWN" }, receipt: { requestId, effectOutcome: "unknown", uncertaintyObserved: true, settled: true, executionOutcome: "completed", dispatchStarted: true, nativeOutcome: { operationId: "fixture.native.original", mutationOutcome: "unknown" } } }).then(() => { confirmed = true; release(); });
  try {
    await assert.rejects(archive.flushScope(identity));
    assert.equal(confirmed, false); assert.equal(archive.snapshot().reservations, 1);
    let nativeCode: string | undefined;
    try { await fs.readFile(path.join(archive.root, outcomeKey(identity, requestId).slice(0, 2), outcomeKey(identity, requestId) + ".json")); }
    catch (error) { nativeCode = (error as NodeJS.ErrnoException).code; }
    assert.ok(nativeCode === "ENOENT" || nativeCode === "ENOTDIR", "fixture must fail at its owned file path component");
    if (nativeCode === "ENOENT") {
      const row = await archive.read(identity, requestId); assert.ok(row); assert.equal(row.archive, "unconfirmed");
      assert.equal((row.record.firstFailure as { code: string }).code, "ORIGINAL_UNKNOWN");
    } else await assert.rejects(archive.read(identity, requestId), error => {
      assert.ok(error instanceof OutcomeFirstUnavailableError); assert.equal(error.requestId, requestId);
      assert.equal((error.current.nativeOutcome as { operationId: string }).operationId, "fixture.native.original");
      assert.equal("firstObservation" in error, false); return true;
    });
    assert.throws(() => archive.reserve(identity, "second-call", "mutation"), /cannot preserve/);
    const read = archive.reserve(identity, "read-call", "read"); read();
    await fs.unlink(archive.root); await archive.flushScope(identity); await actual; await archive.joinScope(identity);
    assert.equal(confirmed, true); assert.equal(archive.snapshot().reservations, 0);
    const original = await archive.read(identity, requestId); assert.ok(original); assert.equal(original.archive, "confirmed");
    assert.equal((original.record.firstObservation.nativeOutcome as { operationId: string }).operationId, "fixture.native.original");
  } finally {
    const stat = await fs.lstat(archive.root);
    if (stat.isFile()) { assert.equal(await fs.readFile(archive.root, "utf8"), "fixture-only block"); await fs.unlink(archive.root); }
    await archive.flushScope(identity); await actual; await archive.dispose(); await fs.rm(root, { recursive: true });
  }
});

test("failed actual fd close retains the same resource and original confirmation join", { timeout: 10000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "outcome-fd-owner-"));
  let original: FileHandle | undefined, rejectClose = true, opens = 0, actualCloses = 0;
  const archive = new AsyncPluginOutcomeArchive(path.join(root, "archive"), {
    pendingLimitPerPlugin: 1,
    async openFile(filename) {
      opens++; const file = await fs.open(filename, "wx", 0o600); original = file;
      const nativeClose = file.close.bind(file);
      Reflect.apply(EventEmitter.prototype.once, file, ["close", () => { actualCloses++; }]);
      file.close = async () => { if (rejectClose) throw new Error("fixture-close-rejected-with-fd-open"); await nativeClose(); };
      return file;
    },
  });
  const requestId = "fd-original", release = archive.reserve(identity, requestId, "mutation");
  let confirmed = false, joined = false;
  const actual = archive.observe({ identity, requestId, receipt: { uncertaintyObserved: true, effectOutcome: "unknown", dispatchStarted: true, settled: true, executionOutcome: "completed" } }).then(() => { confirmed = true; release(); });
  const join = archive.joinScope(identity).then(() => { joined = true; });
  try {
    await assert.rejects(archive.flushScope(identity), /original unknown outcome/i);
    assert.ok(original); await original.stat();
    assert.equal(opens, 1); assert.equal(actualCloses, 0); assert.equal(confirmed, false); assert.equal(joined, false);
    assert.equal(archive.snapshot().reservations, 1); assert.equal(archive.snapshot().writes, 0);
    assert.throws(() => archive.reserve(identity, "next-mutation", "mutation"), /cannot preserve/);
    // Another failed metadata flush cannot substitute a fresh descriptor.
    await assert.rejects(archive.flushScope(identity)); await original.stat();
    assert.equal(opens, 1); assert.equal(joined, false);
    rejectClose = false; await archive.flushScope(identity); await actual; await join;
    assert.equal(opens, 1); assert.equal(actualCloses, 1); assert.equal(confirmed, true); assert.equal(joined, true);
    await assert.rejects(original.stat(), { code: "EBADF" });
    assert.equal(archive.snapshot().reservations, 0); assert.equal(archive.snapshot().writes, 1);
  } finally {
    rejectClose = false;
    await archive.flushScope(identity); await actual; await join; await archive.dispose();
    await fs.rm(root, { recursive: true });
  }
});

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const uncertainty = (requestId: string, late = false) => ({ identity, requestId, firstFailure: { code: late ? "LATE_MUST_NOT_REPLACE" : "ORIGINAL_FIRST" }, receipt: { requestId, uncertaintyObserved: true, effectOutcome: "unknown", dispatchStarted: true, settled: late, executionOutcome: late ? "completed" : "running" } });

test("pending cold-first point-read joins original loading after real hot eviction", { timeout: 10000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "outcome-cold-first-"));
  const entered = gate(), allowRead = gate(), originalName = outcomeKey(identity, "original") + ".json";
  let gated = false, loadCount = 0;
  const archive = new AsyncPluginOutcomeArchive(path.join(root, "archive"), { hotLimit: 2, async readCold(filename) {
    if (gated && path.basename(filename) === originalName) { loadCount++; entered.resolve(); await allowRead.promise; }
    return fs.readFile(filename, "utf8");
  } });
  let actual: Promise<void> | undefined, read: ReturnType<AsyncPluginOutcomeArchive["read"]> | undefined;
  try {
    await archive.observe(uncertainty("original")); await archive.observe(uncertainty("second")); await archive.observe(uncertainty("third"));
    assert.equal(archive.snapshot().hot, 2); gated = true;
    actual = archive.observe(uncertainty("original", true)); await entered.promise;
    let readSettled = false;
    read = archive.read(identity, "original").finally(() => { readSettled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(readSettled, false, "a tentative late current cannot be exposed as first"); assert.equal(loadCount, 1);
    allowRead.resolve(); const result = await read; assert.ok(result);
    assert.equal((result.record.firstFailure as { code: string }).code, "ORIGINAL_FIRST");
    assert.equal(result.record.firstObservation.executionOutcome, "running"); assert.equal(result.record.current.executionOutcome, "completed");
    await actual; const cold = await archive.read(identity, "original"); assert.ok(cold);
    assert.equal(cold.archive, "confirmed"); assert.equal(cold.record.firstObservation.executionOutcome, "running");
  } finally {
    allowRead.resolve(); await Promise.allSettled([...(actual ? [actual] : []), ...(read ? [read] : [])]);
    await archive.dispose(); await fs.rm(root, { recursive: true });
  }
});

test("failed cold-first load exposes current separately and never invents an original first", { timeout: 10000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "outcome-first-unavailable-"));
  const originalName = outcomeKey(identity, "original") + ".json";
  let failCold = false;
  const archive = new AsyncPluginOutcomeArchive(path.join(root, "archive"), { hotLimit: 1, async readCold(filename) {
    if (failCold && path.basename(filename) === originalName) throw Object.assign(new Error("fixture-owned cold read failed"), { code: "EIO" });
    return fs.readFile(filename, "utf8");
  } });
  let actual: Promise<void> | undefined;
  try {
    await archive.observe(uncertainty("original")); await archive.observe(uncertainty("evict")); failCold = true;
    actual = archive.observe(uncertainty("original", true)); await assert.rejects(archive.flushScope(identity));
    await assert.rejects(archive.read(identity, "original"), error => {
      assert.ok(error instanceof OutcomeFirstUnavailableError); assert.equal(error.code, "OUTCOME_FIRST_UNAVAILABLE");
      assert.equal(error.current.executionOutcome, "completed"); assert.equal("record" in error, false); assert.equal("firstObservation" in error, false); return true;
    });
    const bytes = JSON.parse(await fs.readFile(path.join(archive.root, outcomeKey(identity, "original").slice(0, 2), originalName), "utf8"));
    assert.equal(bytes.firstObservation.executionOutcome, "running"); assert.equal(bytes.current.executionOutcome, "running");
    failCold = false; await archive.flushScope(identity); await actual;
    const restored = await archive.read(identity, "original"); assert.ok(restored);
    assert.equal(restored.record.firstObservation.executionOutcome, "running"); assert.equal(restored.record.current.executionOutcome, "completed");
  } finally {
    failCold = false; await archive.flushScope(identity); if (actual) await actual;
    await archive.dispose(); await fs.rm(root, { recursive: true });
  }
});
