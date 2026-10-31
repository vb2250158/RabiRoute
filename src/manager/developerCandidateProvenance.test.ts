import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeveloperCandidateProvenance } from "./developerCandidateProvenance.js";

test("local origin survives owner restart, remains hash-scoped and cannot be provided by a foreign root", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-origin-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"), foreign = path.join(root, "foreign"); await fs.mkdir(sourceRoot); await fs.mkdir(foreign);
  const options = { sourceRoot, stateRoot: path.join(root, "state") }; const first = new DeveloperCandidateProvenance(options);
  const sha = "a".repeat(64);
  assert.equal(await first.source("source-patch", sha), undefined);
  await first.record("source-patch", sha, sourceRoot);
  const restarted = new DeveloperCandidateProvenance(options);
  assert.equal(await restarted.source("source-patch", sha), await fs.realpath(sourceRoot));
  assert.equal(await restarted.source("web-patch", sha), undefined);
  assert.equal(await restarted.source("source-patch", "b".repeat(64)), undefined);
  await assert.rejects(restarted.record("source-patch", "b".repeat(64), foreign), /outside the Host-bound/);
  await fs.writeFile(path.join(options.stateRoot, "developer-provenance", `source-patch-${"b".repeat(64)}.json`), "{damaged");
  await assert.rejects(restarted.source("source-patch", "b".repeat(64)));
  assert.equal(await restarted.source("source-patch", sha), await fs.realpath(sourceRoot));
  assert.equal(await restarted.source("source-patch", "c".repeat(64)), undefined);
});
