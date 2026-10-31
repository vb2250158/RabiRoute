import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import test from "node:test";
import { DeveloperCandidateAdmission } from "./developerCandidateAdmission.js";
import { DeveloperCandidateProvenance } from "./developerCandidateProvenance.js";
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-managed-admission-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"), candidateRoot = path.join(root, "candidate"), tests = path.join(root, "tests");
  await fs.mkdir(sourceRoot); await fs.mkdir(candidateRoot); await fs.mkdir(tests);
  await fs.writeFile(path.join(sourceRoot, "package.json"), '{"type":"module"}');
  for (const file of ["scripts/verify-plugin-candidate.mjs", "scripts/lib/developer-verification.mjs", "dist/plugin-kernel/hotPatchCandidateStore.js", "dist/plugin-kernel/hotPatchResourceStore.js", "dist/manager/webPatchCatalog.js", "dist/plugin-kernel/automaticCodeRuntime.js", "dist/plugin-kernel/hotPatchIterator.js"]) {
    await fs.mkdir(path.dirname(path.join(sourceRoot, file)), { recursive: true }); await fs.copyFile(path.join(repository, file), path.join(sourceRoot, file));
  }
  await fs.symlink(path.join(repository, "node_modules"), path.join(sourceRoot, "node_modules"), "junction");
  await fs.writeFile(path.join(sourceRoot, "verify.json"), JSON.stringify({ sourceRoot: tests, inputs: ["check.test.mjs"], tests: ["check.test.mjs"], deterministic: false, completeInputClosure: false }));
  await fs.writeFile(path.join(sourceRoot, "developer-verification.json"), JSON.stringify({ schemaVersion: 1,
    sourcePatches: [{ moduleId: "fixture-source", verificationConfig: "verify.json" }], web: { verificationConfig: "verify.json" } }));
  const identity = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-generation" };
  return { root, sourceRoot, candidateRoot, tests, admission: new DeveloperCandidateAdmission({ sourceRoot, identity: () => identity }),
    origins: new DeveloperCandidateProvenance({ sourceRoot, stateRoot: path.join(root, "state") }) };
}

test("managed source proof restores after owner restart and rejects changed bytes before publication", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const bytes = JSON.stringify({ schemaVersion: 1, sourceHash: "a".repeat(64), compatibilityHash: "b".repeat(64), initializationSource: "", environmentDescriptors: "", dependencies: [], functionNames: ["value"], exported: ["value"], implementations: { value: "() => 42" }, sourceMaps: {} });
  const sha256 = hash(bytes), filename = path.join(f.candidateRoot, sha256 + ".json"); await fs.writeFile(filename, bytes);
  await fs.writeFile(path.join(f.tests, "check.test.mjs"), `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.RABI_CANDIDATE_ROOT,'${sha256}.json'))).implementations.value,'() => 42');`);
  await f.origins.record("source-patch", sha256, f.sourceRoot);
  const restarted = new DeveloperCandidateProvenance({ sourceRoot: f.sourceRoot, stateRoot: path.join(f.root, "state") });
  const input = { kind: "source-patch" as const, moduleId: "fixture-source", sha256, candidateRoot: f.candidateRoot, originSourceRoot: await restarted.source("source-patch", sha256) };
  const proof = await f.admission.prepareManagedCandidate(input); assert.equal(proof.mode, "verified-development"); proof.assertCurrent();
  await fs.appendFile(filename, " "); assert.throws(proof.assertCurrent, /changed before publication/);
  assert.equal((await f.admission.prepareManagedCandidate({ ...input, originSourceRoot: undefined })).mode, "existing-contract");
  for (const sourcePatches of [{ invalid: true }, [{ moduleId: "fixture-source", verificationConfig: "verify.json" }, { moduleId: "fixture-source", verificationConfig: "other.json" }]]) {
    await fs.writeFile(path.join(f.sourceRoot, "developer-verification.json"), JSON.stringify({ schemaVersion: 1, sourcePatches }));
    const ordinary = await f.admission.prepareManagedCandidate(input);
    assert.equal(ordinary.mode, "existing-contract"); assert.match(ordinary.diagnostic!, /configuration is unavailable/);
  }
});

test("managed Web uses the real manifest owner and preserves original contract without local provenance", { timeout: 60000 }, async t => {
  const f = await fixture(t); const files = [];
  for (const [relative, body] of [["web/index.html", '<script src="/assets/main.js"></script>'], ["web/assets/main.js", "export const version=1;"], ["docs/readme.md", "fixture documentation"]]) {
    await fs.mkdir(path.dirname(path.join(f.candidateRoot, relative)), { recursive: true }); await fs.writeFile(path.join(f.candidateRoot, relative), body);
    files.push({ path: relative, sha256: hash(body), size: Buffer.byteLength(body) });
  }
  const manifest = JSON.stringify({ schemaVersion: 1, backend: "a".repeat(64), files, modules: [] }), sha256 = hash(manifest);
  await fs.writeFile(path.join(f.candidateRoot, "manifest.json"), manifest);
  await fs.writeFile(path.join(f.tests, "check.test.mjs"), `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; assert.equal(fs.readFileSync(path.join(process.env.RABI_CANDIDATE_ROOT,'web/assets/main.js'),'utf8'),'export const version=1;');`);
  const input = { kind: "web-patch" as const, sha256, candidateRoot: f.candidateRoot };
  assert.equal((await f.admission.prepareManagedCandidate(input)).mode, "existing-contract");
  await f.origins.record("web-patch", sha256, f.sourceRoot);
  const proof = await f.admission.prepareManagedCandidate({ ...input, originSourceRoot: await f.origins.source("web-patch", sha256) });
  assert.equal(proof.mode, "verified-development"); proof.assertCurrent();
});
