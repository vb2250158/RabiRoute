import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import test from "node:test";
import { compileHotPatchModule } from "../../scripts/lib/hot-patch-compiler.mjs";
import { GenerationRuntime } from "../plugin-kernel/generationRuntime.ts";
import { ManagerSourcePatchService } from "./sourcePatchService.ts";
import { DeveloperCandidateAdmission } from "./developerCandidateAdmission.ts";
import { WebPatchService } from "./webPatchService.ts";
import { buildWebPatch } from "./webPatchCatalog.ts";
const repository = path.resolve(import.meta.dirname, "../..");
const hash = text => createHash("sha256").update(text).digest("hex");
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-developer-publication-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"), tests = path.join(root, "tests"); await fs.mkdir(tests); await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, "package.json"), '{"type":"module"}');
  for (const file of ["scripts/verify-plugin-candidate.mjs", "scripts/lib/developer-verification.mjs", "dist/plugin-kernel/hotPatchCandidateStore.js", "dist/plugin-kernel/hotPatchResourceStore.js", "dist/manager/webPatchCatalog.js", "dist/plugin-kernel/automaticCodeRuntime.js", "dist/plugin-kernel/hotPatchIterator.js"]) {
    await fs.mkdir(path.dirname(path.join(sourceRoot, file)), { recursive: true }); await fs.copyFile(path.join(repository, file), path.join(sourceRoot, file));
  }
  await fs.symlink(path.join(repository, "node_modules"), path.join(sourceRoot, "node_modules"), "junction");
  await fs.writeFile(path.join(sourceRoot, "verify.json"), JSON.stringify({ sourceRoot: tests, inputs: ["check.test.mjs"], tests: ["check.test.mjs"], deterministic: false, completeInputClosure: false }));
  await fs.writeFile(path.join(sourceRoot, "developer-verification.json"), JSON.stringify({ schemaVersion: 1, sourcePatches: [{ moduleId: "sample", verificationConfig: "verify.json" }], web: { verificationConfig: "verify.json" } }));
  const behavior = path.join(tests, "check.test.mjs"); await fs.writeFile(behavior, 'throw new Error("fixture behavior failed")');
  return { root, sourceRoot, behavior };
}

test("source owner preserves original receipt, old behavior and provenance through failed validation and restart", { timeout: 120000 }, async t => {
  const f = await setup(t), runtime = new GenerationRuntime({ host: "manager" }); t.after(() => runtime.dispose());
  const identity = () => { const current = runtime.current(); return { applicationGenerationId: current.applicationGenerationId, managerInstanceId: current.managerInstanceId, pluginGenerationId: current.id }; };
  const baselineRoot = path.join(f.root, "baselines"), stateRoot = path.join(f.root, "state");
  const write = async (directory, module) => { await fs.mkdir(directory, { recursive: true }); const bytes = JSON.stringify(module), sha = hash(bytes); await fs.writeFile(path.join(directory, sha + ".json"), bytes); return sha; };
  const baseline = await write(baselineRoot, compileHotPatchModule("export function read() { return 1; }"));
  const candidate = await write(path.join(stateRoot, "candidates"), compileHotPatchModule("export function read() { return 2; }"));
  await fs.writeFile(path.join(baselineRoot, "catalog.json"), JSON.stringify({ schemaVersion: 1, modules: [{ id: "sample", sha256: baseline, contract: {} }] }));
  const options = { baselineRoot, stateRoot, runtime, developerSourceRoot: f.sourceRoot, developerAdmission: new DeveloperCandidateAdmission({ sourceRoot: f.sourceRoot, identity }) };
  let service = new ManagerSourcePatchService(options); t.after(() => service.stop());
  assert.equal((await service.invoke("sample", "read", [])).value, 1);
  await service.recordLocalCandidate(candidate, f.sourceRoot); await service.stop(); service = new ManagerSourcePatchService(options);
  const request = { ...identity(), operationId: "original-operation", action: "apply", moduleId: "sample", candidateSha256: candidate, expectedRevision: 0 };
  await assert.rejects(service.publish(request), /matching verification failed/);
  assert.equal((await service.invoke("sample", "read", [])).value, 1); assert.equal(await service.operation(request.operationId), undefined);
  await fs.writeFile(f.behavior, "import assert from 'node:assert/strict'; assert.ok(process.env.RABI_CANDIDATE_ROOT);");
  assert.equal((await service.publish(request)).state, "committed"); assert.equal((await service.invoke("sample", "read", [])).value, 2);
  await fs.writeFile(f.behavior, 'throw new Error("must not rerun committed operation")');
  assert.equal((await service.publish(request)).state, "committed");
  assert.equal((await service.publish({ ...identity(), operationId: "rollback-original", action: "rollback", moduleId: "sample", expectedRevision: 1 })).state, "committed");
  assert.equal((await service.invoke("sample", "read", [])).value, 1);
  const originPath = path.join(stateRoot, "developer-provenance", `source-patch-${candidate}.json`);
  await fs.writeFile(originPath, "{damaged");
  await assert.rejects(service.publish({ ...request, operationId: "damaged-origin", expectedRevision: 2 }));
  assert.equal((await service.invoke("sample", "read", [])).value, 1);
  await service.recordLocalCandidate(candidate, f.sourceRoot);
  await fs.writeFile(path.join(f.sourceRoot, "developer-verification.json"), JSON.stringify({ schemaVersion: 1, sourcePatches: ["sample", "new-module"].map(moduleId => ({ moduleId, verificationConfig: "verify.json" })) }));
  await assert.rejects(service.ensureModule("new-module", candidate), /matching verification failed/);
  assert.ok(!service.status().modules.some(module => module.id === "new-module"));
  await fs.writeFile(f.behavior, "import assert from 'node:assert/strict'; assert.ok(process.env.RABI_CANDIDATE_ROOT);");
  await service.ensureModule("new-module", candidate);
  assert.equal((await service.invoke("new-module", "read", [])).value, 2);
  const runnerPid = path.join(f.root, "verification.pid");
  await fs.writeFile(f.behavior, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(runnerPid)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const cancelled = assert.rejects(service.publish({ ...identity(), operationId: "cancel-original", action: "apply", moduleId: "sample", candidateSha256: candidate, expectedRevision: 2 }), /matching verification failed|abort/i);
  const deadline = Date.now() + 10000;
  while (!await fs.stat(runnerPid).catch(() => undefined)) {
    assert.ok(Date.now() < deadline, "real verification runner started");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await Promise.race([runtime.publishSourcePatch(runtime.current().id, async () => "independent"), new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error("verification held the publication queue")), 1000); timeout.unref(); })]), "independent");
  const pid = Number(await fs.readFile(runnerPid, "utf8")); await service.stop(); await cancelled;
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("Web owner keeps old release on verification failure then publishes same hash and reuses original receipt", { timeout: 120000 }, async t => {
  const f = await setup(t); const packageRoot = path.join(f.root, "package"), stateRoot = path.join(f.root, "web-state");
  const write = async (name, body) => { const filename = path.join(packageRoot, name); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, body); };
  await write("dist/manager.js", "export const fixture = 1;"); await write("ribiwebgui/dist/index.html", '<script src="/assets/main.js"></script>'); await write("ribiwebgui/dist/assets/main.js", "export const value=1;"); await write("docs/readme.md", "fixture");
  await fs.mkdir(path.join(packageRoot, "assets"));
  await fs.mkdir(path.join(packageRoot, "dist/plugins/packages"), { recursive: true });
  const identity = () => ({ applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", pluginGenerationId: "fixture-generation" });
  const options = { packageRoot, stateRoot, identity, serialize: async (_generation, action) => action(), developerSourceRoot: f.sourceRoot, developerAdmission: new DeveloperCandidateAdmission({ sourceRoot: f.sourceRoot, identity }) };
  let service = new WebPatchService(options); t.after(() => service.stop()); await service.ready; const before = service.status().active;
  await write("ribiwebgui/dist/assets/main.js", "export const value=2;");
  const output = path.join(packageRoot, "dist/web-patches"), candidate = await buildWebPatch(packageRoot, output);
  await write("ribiwebgui/dist/assets/main.js", "export const value=1;");
  await service.importLocalCandidate(path.join(output, candidate), candidate, f.sourceRoot); await service.stop(); service = new WebPatchService(options); await service.ready;
  const request = { ...identity(), operationId: "original-web", candidate, expectedRevision: service.status().revision };
  await assert.rejects(service.publish(request), /matching verification failed/); assert.equal(service.status().active, before); assert.equal(service.operation(request.operationId), undefined);
  await fs.writeFile(f.behavior, "import assert from 'node:assert/strict'; assert.ok(process.env.RABI_CANDIDATE_ROOT);");
  assert.equal((await service.publish(request)).active, candidate);
  await fs.writeFile(f.behavior, 'throw new Error("must not replay")'); assert.equal((await service.publish(request)).active, candidate);
  assert.equal((await service.publish({ ...identity(), operationId: "rollback-web", candidate: before, expectedRevision: 1 })).active, before);
});
