import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DeveloperCandidateAdmission } from "./developerCandidateAdmission.js";
import { PluginPackageCatalog, loadPluginProfile } from "../plugin-kernel/profile.js";
import { diagnosticsCandidateForTests } from "./diagnosticsCandidate.fixture.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function fixture(t: any) {
  const built = await diagnosticsCandidateForTests("io.rabiroute.manager.diagnostics");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-admission-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate"); await fs.cp(built, candidateRoot, { recursive: true });
  const sourceRoot = path.join(root, "source"); await fs.mkdir(path.join(sourceRoot, "scripts/lib"), { recursive: true });
  for (const file of ["scripts/verify-plugin-candidate.mjs", "scripts/lib/developer-verification.mjs"]) await fs.copyFile(path.join(repository, file), path.join(sourceRoot, file));
  await fs.symlink(path.join(repository, "node_modules"), path.join(sourceRoot, "node_modules"), "junction");
  const tests = path.join(root, "tests"); await fs.mkdir(tests);
  await fs.writeFile(path.join(tests, "check.test.mjs"), `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; const manifest=JSON.parse(fs.readFileSync(path.join(process.env.RABI_PLUGIN_CANDIDATE_ROOT,'packages/io.rabiroute.manager.diagnostics/1.0.0/rabi.plugin.json'))); assert.equal(manifest.id,'io.rabiroute.manager.diagnostics');`);
  await fs.writeFile(path.join(sourceRoot, "verify.json"), JSON.stringify({ sourceRoot: tests, inputs: ["check.test.mjs"], tests: ["check.test.mjs"], deterministic: false, completeInputClosure: false }));
  await fs.writeFile(path.join(sourceRoot, "developer-verification.json"), JSON.stringify({ schemaVersion: 1, plugins: [{ packageId: "io.rabiroute.manager.diagnostics", candidateRoot, verificationConfig: "verify.json" }] }));
  const profilePath = path.join(root, "profile.json"); await fs.writeFile(profilePath, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "diagnostics", package: "io.rabiroute.manager.diagnostics", version: "1.0.0", enabled: true, config: {}, grants: [] }] }));
  const catalog = new PluginPackageCatalog([path.join(candidateRoot, "packages")]); t.after(() => catalog.dispose());
  const loaded = await loadPluginProfile({ profilePath, packageCatalog: catalog, runtimeRoot: path.join(root, "runtime"), host: "manager" });
  const candidate = loaded.candidates[0]; assert.ok(candidate);
  const identity = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-baseline" };
  return { root, sourceRoot, candidateRoot, candidate, identity, tests, admission: new DeveloperCandidateAdmission({ sourceRoot, identity: () => identity }) };
}

test("formal Loader candidate receives real local CLI verification and cannot cross identity or spoof passed", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const admitted = await f.admission.preparePlugin(f.candidate);
  assert.equal(admitted.mode, "verified-development"); admitted.assertCurrent();
  assert.match(admitted.packageRevision!, /^[a-f0-9]{64}$/); assert.match(admitted.candidateSha256!, /^[a-f0-9]{64}$/);
  f.identity.managerInstanceId = "another-manager";
  assert.throws(admitted.assertCurrent, /identity changed/);
  await assert.rejects(f.admission.preparePlugin({ ...f.candidate, passed: true } as any), /original PackageCatalog/);
});

test("matching verification failure rejects only this candidate; unconfigured legitimate package retains original contract", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.tests, "check.test.mjs"), 'throw new Error("synthetic failing behavior")');
  await assert.rejects(f.admission.preparePlugin(f.candidate), /matching verification failed/);
  await fs.writeFile(path.join(f.sourceRoot, "developer-verification.json"), JSON.stringify({ schemaVersion: 1, plugins: [] }));
  const ordinary = await f.admission.preparePlugin(f.candidate);
  assert.equal(ordinary.mode, "existing-contract"); ordinary.assertCurrent();
});


test("a rejected development candidate keeps its original instance while a tree-external package remains eligible", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const externalRoot = path.join(f.root, "external"); await fs.cp(f.candidateRoot, externalRoot, { recursive: true });
  const externalProfile = path.join(f.root, "external-profile.json");
  await fs.writeFile(externalProfile, JSON.stringify({ schemaVersion: 2, readyRequires: [], instances: [{ id: "external-diagnostics", package: "io.rabiroute.manager.diagnostics", version: "1.0.0", enabled: true, config: {}, grants: [] }] }));
  const catalog = new PluginPackageCatalog([path.join(externalRoot, "packages")]); t.after(() => catalog.dispose());
  const loaded = await loadPluginProfile({ profilePath: externalProfile, packageCatalog: catalog, runtimeRoot: path.join(f.root, "external-runtime"), host: "manager" });
  const external = loaded.candidates[0]; assert.ok(external);
  await fs.writeFile(path.join(f.tests, "check.test.mjs"), 'throw new Error("synthetic regression")');
  const selected = await f.admission.prepareSelection([f.candidate, external], [f.candidate]);
  assert.deepEqual(selected.candidates, [f.candidate, external]);
  assert.equal(selected.failures.length, 1); assert.equal(selected.failures[0].instanceId, "diagnostics");
  assert.equal(selected.failures[0].retained, true); selected.assertCurrent();
});


test("a target cannot borrow a sibling build receipt, and malformed developer config does not disable ordinary installation", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const evidencePath = path.join(f.candidateRoot, "build-evidence.json");
  const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));
  evidence.artifacts.files = evidence.artifacts.files.filter((file: { path: string }) => !file.path.startsWith("packages/io.rabiroute.manager.diagnostics/"));
  await fs.writeFile(evidencePath, JSON.stringify(evidence));
  await assert.rejects(f.admission.preparePlugin(f.candidate), /does not cover this developer package/);
  await fs.writeFile(path.join(f.sourceRoot, "developer-verification.json"), "{broken");
  const selected = await f.admission.prepareSelection([f.candidate], []);
  assert.deepEqual(selected.candidates, [f.candidate]); assert.equal(selected.failures.length, 0);
  assert.equal(selected.diagnostics.length, 1); assert.match(selected.diagnostics[0], /Existing installation validation/);
});


test("unavailable bound source or unreadable local config does not disable unrelated installation", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const unavailable = new DeveloperCandidateAdmission({ sourceRoot: path.join(f.root, "missing"), identity: () => f.identity });
  const result = await unavailable.preparePlugin(f.candidate);
  assert.equal(result.mode, "existing-contract"); assert.match(result.diagnostic!, /source root is unavailable/);
  await fs.unlink(path.join(f.sourceRoot, "developer-verification.json"));
  await fs.mkdir(path.join(f.sourceRoot, "developer-verification.json"));
  const unreadable = await f.admission.preparePlugin(f.candidate);
  assert.equal(unreadable.mode, "existing-contract"); assert.match(unreadable.diagnostic!, /Cannot read/);
});
