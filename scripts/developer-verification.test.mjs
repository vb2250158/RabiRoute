import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { verifyPluginCandidate, inspectPluginBuild, analyzeVerificationImpact, fingerprintFiles } from './lib/developer-verification.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-proof-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const candidateRoot = path.join(root, 'candidate');
  await fs.mkdir(sourceRoot);
  await fs.mkdir(path.join(candidateRoot, 'packages/example/1'), { recursive: true });
  const body = 'export const value = 42;';
  await fs.writeFile(path.join(candidateRoot, 'packages/example/1/index.mjs'), body);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const files = [{ path: 'packages/example/1/index.mjs', sha256: hash(body) }];
  await fs.writeFile(path.join(candidateRoot, 'build-evidence.json'), JSON.stringify({ kind: 'plugin-build', artifacts: { files, sha256: hash(JSON.stringify(files)) } }));
  await fs.writeFile(path.join(sourceRoot, 'check.test.mjs'), `import assert from 'node:assert/strict'; import { pathToFileURL } from 'node:url'; import path from 'node:path'; const target = path.join(process.env.RABI_PLUGIN_CANDIDATE_ROOT, 'packages/example/1/index.mjs'); assert.equal((await import(pathToFileURL(target))).value, 42);`);
  return { sourceRoot, candidateRoot, cacheRoot: path.join(root, 'cache'), inputs: ['check.test.mjs'], tests: ['check.test.mjs'], deterministic: true, completeInputClosure: true };
}

test('executes frozen candidate then reuses only matching successful deterministic evidence', async t => {
  const options = await fixture(t);
  const first = await verifyPluginCandidate(options);
  assert.equal(first.status, 'passed'); assert.equal(first.reused, false);
  assert.equal((await verifyPluginCandidate(options)).reused, true);
  await fs.appendFile(path.join(options.sourceRoot, 'check.test.mjs'), '\n// changed test');
  const changed = await verifyPluginCandidate(options);
  assert.equal(changed.reused, false); assert.notEqual(first.key, changed.key);
});

test('candidate tampering or an added undeclared artifact cannot reuse proof', async t => {
  const options = await fixture(t);
  await verifyPluginCandidate(options);
  await fs.writeFile(path.join(options.candidateRoot, 'packages/example/1/extra.mjs'), 'export {};');
  await assert.rejects(inspectPluginBuild(options.candidateRoot), /differ/);
});

test('unclosed and nondeterministic tests execute each time; failures never cache', async t => {
  const options = await fixture(t);
  assert.equal((await verifyPluginCandidate({ ...options, deterministic: false })).reusable, false);
  assert.equal((await verifyPluginCandidate({ ...options, completeInputClosure: false })).reusable, false);
  await fs.writeFile(path.join(options.sourceRoot, 'check.test.mjs'), 'throw new Error("expected failure")');
  for (let i = 0; i < 2; i++) {
    const result = await verifyPluginCandidate(options);
    assert.equal(result.status, 'failed'); assert.equal(result.reused, false); assert.equal(result.reusable, false);
  }
});

test('directory membership and corrupt cache force fresh execution', async t => {
  const options = await fixture(t);
  await fs.mkdir(path.join(options.sourceRoot, 'config'));
  options.inputs.push('config');
  const first = await verifyPluginCandidate(options);
  await fs.writeFile(path.join(options.cacheRoot, `${first.key}.json`), '{broken');
  assert.equal((await verifyPluginCandidate(options)).reused, false);
  await fs.writeFile(path.join(options.sourceRoot, 'config/new.json'), '{}');
  assert.notEqual((await verifyPluginCandidate(options)).key, first.key);
});

test('cancelled execution and mutation cannot become passing evidence', async t => {
  const options = await fixture(t);
  await fs.writeFile(path.join(options.sourceRoot, 'check.test.mjs'), 'await new Promise(r => setTimeout(r, 30000));');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  const result = await verifyPluginCandidate({ ...options, signal: controller.signal });
  clearTimeout(timer);
  assert.equal(result.status, 'cancelled'); assert.equal(result.reusable, false);
  await fs.writeFile(path.join(options.sourceRoot, 'check.test.mjs'), `import fs from 'node:fs'; fs.appendFileSync('check.test.mjs', '// mutation');`);
  assert.equal((await verifyPluginCandidate(options)).status, 'inputs-mutated');
});

test('CLI resolves config paths and reports actual passing evidence', async t => {
  const options = await fixture(t);
  const configPath = path.join(options.sourceRoot, 'verification.json');
  await fs.writeFile(configPath, JSON.stringify({ ...options, sourceRoot: '.', candidateRoot: '../candidate', cacheRoot: '../cache' }));
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'verify-plugin-candidate.mjs'), '--config', configPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.mode, 'shadow');
});

test('unavailable optional cache does not prevent normal verification', async t => {
  const options = await fixture(t);
  await fs.writeFile(options.cacheRoot, 'not a directory');
  const result = await verifyPluginCandidate(options);
  assert.equal(result.status, 'passed'); assert.ok(result.cacheWriteError);
});

test('inherited public directory environment changes invalidate cached evidence', async t => {
  const options = await fixture(t);
  const previous = process.env.HOME;
  try {
    process.env.HOME = '/verification-home-a';
    const first = await verifyPluginCandidate(options);
    process.env.HOME = '/verification-home-b';
    const second = await verifyPluginCandidate(options);
    assert.equal(second.reused, false); assert.notEqual(first.key, second.key);
    assert.notEqual(first.environmentSha256, second.environmentSha256);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
});

test('unrelated candidate files and sibling packages are not exposed to tests', async t => {
  const options = await fixture(t);
  await fs.mkdir(path.join(options.candidateRoot, 'packages/other/1'), { recursive: true });
  await fs.writeFile(path.join(options.candidateRoot, 'packages/other/1/extra.json'), '{}');
  await fs.writeFile(path.join(options.candidateRoot, 'extra.json'), '{}');
  await fs.writeFile(path.join(options.sourceRoot, 'check.test.mjs'), `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; for(const name of ['extra.json','packages/other','build-evidence.json']) assert.equal(fs.existsSync(path.join(process.env.RABI_PLUGIN_CANDIDATE_ROOT,name)),false);`);
  const first = await verifyPluginCandidate(options);
  assert.equal(first.status, 'passed');
  await fs.writeFile(path.join(options.candidateRoot, 'extra.json'), '{"changed":true}');
  const second = await verifyPluginCandidate(options);
  assert.equal(second.reused, true); assert.equal(first.key, second.key);
});

async function impactFixture(t) {
  const options = await fixture(t);
  const root = options.sourceRoot;
  const units = ['a', 'b', 'c'].map(id => ({ id, inputs: [id], tests: [`${id}/test.mjs`] }));
  for (const unit of units) {
    await fs.mkdir(path.join(root, unit.id));
    await fs.writeFile(path.join(root, unit.id, 'index.ts'), 'export const value = 1;');
    await fs.writeFile(path.join(root, unit.tests[0]), 'import "node:assert/strict";');
  }
  const analyze = async (baseline, currentUnits = units) => analyzeVerificationImpact({ sourceRoot: root, files: (await fingerprintFiles(root, ['a', 'b', 'c'])).entries, units: currentUnits, baseline, fullTests: units.flatMap(unit => unit.tests) });
  return { root, units, analyze };
}

test('impact graph follows type/resource imports and selects reverse consumers without unrelated units', async t => {
  const { root, analyze } = await impactFixture(t);
  await fs.writeFile(path.join(root, 'a/schema.json'), '{}');
  await fs.writeFile(path.join(root, 'b/index.ts'), 'import type { Value } from "../a/index.js"; import data from "../a/schema.json";');
  const baseline = (await analyze()).snapshot;
  await fs.writeFile(path.join(root, 'a/schema.json'), '{"changed":true}');
  const impact = await analyze(baseline);
  assert.equal(impact.expanded, false);
  assert.deepEqual(impact.selectedUnits, ['a', 'b']);
  assert.deepEqual(impact.selectedTests, ['a/test.mjs', 'b/test.mjs']);
  assert.ok(!impact.selectedUnits.includes('c'));
});

test('impact graph handles rename, deletion, added imports and changed tests', async t => {
  const { root, analyze } = await impactFixture(t);
  let baseline = (await analyze()).snapshot;
  await fs.rename(path.join(root, 'a/index.ts'), path.join(root, 'a/renamed.ts'));
  await fs.writeFile(path.join(root, 'b/index.ts'), 'export { value } from "../a/renamed.js";');
  let impact = await analyze(baseline);
  assert.deepEqual(impact.selectedUnits, ['a', 'b']);
  assert.ok(impact.changes.includes('a/index.ts')); assert.ok(impact.changes.includes('a/renamed.ts'));
  baseline = impact.snapshot;
  await fs.writeFile(path.join(root, 'c/test.mjs'), 'import "node:assert";');
  impact = await analyze(baseline);
  assert.deepEqual(impact.selectedUnits, ['c']);
  baseline = impact.snapshot;
  await fs.rm(path.join(root, 'a/renamed.ts'));
  impact = await analyze(baseline);
  assert.equal(impact.expanded, true);
  assert.ok(impact.reasons.some(reason => reason.startsWith('unresolved-import:')));
});

test('manifest optional dependencies and actual binding choose their real reverse consumers', async t => {
  const { root, units, analyze } = await impactFixture(t);
  for (const unit of units) {
    unit.manifest = `${unit.id}/rabi.plugin.json`;
    const manifest = unit.id === 'b' ? { provides: [], requires: [], optional: ['sample@1'] } : { provides: ['sample@1'], requires: [], optional: [] };
    await fs.writeFile(path.join(root, unit.manifest), JSON.stringify(manifest));
  }
  units[1].bindings = { 'sample@1': 'a' };
  let baseline = (await analyze()).snapshot;
  await fs.appendFile(path.join(root, 'c/index.ts'), '\n// independent alternative provider');
  let impact = await analyze(baseline);
  assert.deepEqual(impact.selectedUnits, ['c']);
  baseline = impact.snapshot;
  await fs.appendFile(path.join(root, 'a/index.ts'), '\n// actual provider');
  impact = await analyze(baseline);
  assert.deepEqual(impact.selectedUnits, ['a', 'b']);
  baseline = impact.snapshot;
  units[1].bindings = { 'sample@1': 'c' };
  impact = await analyze(baseline);
  assert.deepEqual(impact.selectedUnits, ['b']);
});

test('computed imports and missing full-run coverage expand verification explicitly', async t => {
  const { root, units, analyze } = await impactFixture(t);
  const baseline = (await analyze()).snapshot;
  await fs.writeFile(path.join(root, 'a/index.ts'), 'const name = "./runtime.js"; await import(name);');
  const impact = await analyze(baseline);
  assert.equal(impact.expanded, true);
  assert.deepEqual(impact.selectedUnits, ['a', 'b', 'c']);
  assert.ok(impact.reasons.includes('dynamic-dependency:a/index.ts'));
  const incomplete = await analyzeVerificationImpact({ sourceRoot: root, units, files: impact.snapshot.files, baseline, fullTests: ['a/test.mjs'] });
  assert.deepEqual(incomplete.missingCoverage, ['b/test.mjs', 'c/test.mjs']);
});

test('declared runtime and dynamic file closures connect their resource owners', async t => {
  const { root, units, analyze } = await impactFixture(t);
  await fs.writeFile(path.join(root, 'a/config.json'), '{}');
  await fs.writeFile(path.join(root, 'b/index.ts'), 'import fs from "node:fs"; const moduleName = "../a/index.js"; await import(moduleName);');
  const unknown = await analyze();
  assert.ok(unknown.reasons.includes('runtime-filesystem:b/index.ts'));
  assert.ok(unknown.reasons.includes('dynamic-dependency:b/index.ts'));
  units[1].runtimeInputs = ['a/config.json']; units[1].dynamicInputs = ['a/index.ts'];
  const baseline = (await analyze()).snapshot;
  await fs.writeFile(path.join(root, 'a/config.json'), '{"changed":true}');
  const result = await analyze(baseline);
  assert.equal(result.expanded, false);
  assert.deepEqual(result.selectedUnits, ['a', 'b']);
});

test('unsupported component sources expand instead of silently missing their imports', async t => {
  const { root, analyze } = await impactFixture(t);
  await fs.writeFile(path.join(root, 'b/Consumer.vue'), '<script setup>import { value } from "../a/index.js";</script>');
  const baseline = (await analyze()).snapshot;
  await fs.appendFile(path.join(root, 'a/index.ts'), '\n// changed shared logic');
  const result = await analyze(baseline);
  assert.equal(result.expanded, true);
  assert.ok(result.reasons.includes('unsupported-source:b/Consumer.vue'));
  assert.ok(result.selectedUnits.includes('b'));
});

test('aliased createRequire cannot hide a dependency from the shadow selection', async t => {
  const { root, analyze } = await impactFixture(t);
  await fs.writeFile(path.join(root, 'b/index.ts'), 'import { createRequire as makeLoader } from "node:module"; const load = makeLoader(import.meta.url); load("../a/index.js");');
  const baseline = (await analyze()).snapshot;
  await fs.appendFile(path.join(root, 'a/index.ts'), '\n// changed dependency');
  const result = await analyze(baseline);
  assert.equal(result.expanded, true);
  assert.ok(result.reasons.includes('dynamic-module-loader:b/index.ts'));
  assert.ok(result.selectedUnits.includes('b'));
});

test('IPC cancellation waits for the actual test runner to exit before CLI completion', { timeout: 20000 }, async t => {
  const options = await fixture(t);
  const marker = path.join(options.sourceRoot, 'runner.pid');
  await fs.writeFile(path.join(options.sourceRoot, 'check.test.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); await new Promise(resolve => setTimeout(resolve, 30000));`);
  const config = path.join(options.sourceRoot, 'verification.json');
  await fs.writeFile(config, JSON.stringify({ ...options, deterministic: false }));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'verify-plugin-candidate.mjs'), '--config', config], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '', errors = '', runnerPid;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code)); });
  t.after(async () => {
    if (child.connected) child.send({ type: 'cancel-verification' });
    if (child.exitCode === null) child.kill();
    if (runnerPid) { try { process.kill(runnerPid); } catch { /* Already exited. */ } }
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', message => { if (message.type === 'verification-ready') resolve(); });
  });
  const deadline = Date.now() + 10000;
  while (!runnerPid && Date.now() < deadline) {
    try { runnerPid = Number(await fs.readFile(marker, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!runnerPid) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(runnerPid, errors);
  child.send({ type: 'cancel-verification' });
  assert.equal(await closed, 1, errors);
  assert.equal(JSON.parse(output).status, 'cancelled');
  assert.throws(() => process.kill(runnerPid, 0), error => error.code === 'ESRCH');
  runnerPid = undefined;
});

test('source-patch uses its original content hash and built owner schema, not plugin evidence', async t => {
  const options = await fixture(t);
  const artifact = { schemaVersion: 1, sourceHash: 'a'.repeat(64), compatibilityHash: 'b'.repeat(64), initializationSource: '', environmentDescriptors: '', dependencies: [], functionNames: ['value'], exported: ['value'], implementations: { value: '() => 42' }, sourceMaps: {} };
  const bytes = JSON.stringify(artifact);
  const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = `${artifactSha256}.json`;
  await fs.writeFile(path.join(options.candidateRoot, filename), bytes);
  await fs.writeFile(path.join(options.sourceRoot, 'check.test.mjs'), `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; const root=process.env.RABI_CANDIDATE_ROOT; assert.deepEqual(fs.readdirSync(root),[${JSON.stringify(filename)}]); assert.equal(JSON.parse(fs.readFileSync(path.join(root,${JSON.stringify(filename)}))).implementations.value,'() => 42');`);
  const receipt = await verifyPluginCandidate({ ...options, artifactKind: 'source-patch', artifactSha256 });
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.kind, 'publication-verification'); assert.equal(receipt.artifactKind, 'source-patch');
  assert.equal(receipt.candidateSha256, artifactSha256); assert.notEqual(receipt.inputSha256, artifactSha256);
  assert.deepEqual(receipt.coveredArtifactRoots, [filename]);
  assert.ok(receipt.artifactOwner.some(file => file.path === 'dist/plugin-kernel/hotPatchCandidateStore.js'));
  await fs.appendFile(path.join(options.candidateRoot, filename), ' ');
  await assert.rejects(verifyPluginCandidate({ ...options, artifactKind: 'source-patch', artifactSha256 }), /content hash/);
  const malformed = '{"schemaVersion":1}';
  const malformedHash = createHash('sha256').update(malformed).digest('hex');
  await fs.writeFile(path.join(options.candidateRoot, `${malformedHash}.json`), malformed);
  await assert.rejects(verifyPluginCandidate({ ...options, artifactKind: 'source-patch', artifactSha256: malformedHash }), /artifact schema/);
});

test('web-patch reuses original manifest/file/HTML validation and exposes only declared assets', async t => {
  const options = await fixture(t);
  const files = [];
  for (const [relative, body] of [['web/index.html','<script src="/assets/main.js"></script>'], ['web/assets/main.js','export const version=1;'], ['docs/readme.md','Candidate docs']]) {
    await fs.mkdir(path.dirname(path.join(options.candidateRoot, relative)), { recursive: true });
    await fs.writeFile(path.join(options.candidateRoot, relative), body);
    files.push({ path: relative, sha256: createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body) });
  }
  const manifest = JSON.stringify({ schemaVersion: 1, backend: 'a'.repeat(64), files, modules: [] });
  const artifactSha256 = createHash('sha256').update(manifest).digest('hex');
  await fs.writeFile(path.join(options.candidateRoot, 'manifest.json'), manifest);
  await fs.writeFile(path.join(options.sourceRoot, 'check.test.mjs'), `import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict'; const root=process.env.RABI_CANDIDATE_ROOT; assert.equal(fs.existsSync(path.join(root,'packages')),false); assert.equal(fs.readFileSync(path.join(root,'web/assets/main.js'),'utf8'),'export const version=1;');`);
  const receipt = await verifyPluginCandidate({ ...options, artifactKind: 'web-patch', artifactSha256 });
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.artifactKind, 'web-patch'); assert.equal(receipt.candidateSha256, artifactSha256);
  assert.ok(receipt.artifactOwner.some(file => file.path === 'dist/manager/webPatchCatalog.js'));
  await fs.writeFile(path.join(options.candidateRoot, 'web/assets/main.js'), 'tampered');
  await assert.rejects(verifyPluginCandidate({ ...options, artifactKind: 'web-patch', artifactSha256 }), /file verification failed/);
});
