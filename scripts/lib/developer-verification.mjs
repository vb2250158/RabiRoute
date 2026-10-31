import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value);

/** Conservative dependency analysis over frozen, declared delivery units.
 * Unknown edges expand the shadow selection; they never silently disappear.
 */
export async function analyzeVerificationImpact({ sourceRoot, files, units, baseline, fullTests, externalServices = [] }) {
  const reasons = new Set();
  const edges = new Map();
  const byId = new Map();
  for (const unit of units) {
    if (!unit.id || byId.has(unit.id) || !Array.isArray(unit.inputs) || !Array.isArray(unit.tests)) throw new Error('Impact units require unique IDs, inputs and tests.');
    [...unit.inputs, ...unit.tests, ...(unit.runtimeInputs ?? []), ...(unit.dynamicInputs ?? [])].forEach(relativeFile);
    if (unit.manifest) relativeFile(unit.manifest);
    byId.set(unit.id, unit);
  }
  const owns = (unit, file) => [...unit.inputs, ...unit.tests, ...(unit.manifest ? [unit.manifest] : [])].some(root => file === root || file.startsWith(`${root}/`));
  const owners = file => units.filter(unit => owns(unit, file));
  const addEdge = (consumer, provider, kind) => {
    if (consumer !== provider) edges.set(`${consumer}\0${provider}\0${kind}`, { consumer, provider, kind });
  };
  const fileSet = new Set(files.filter(([, hash]) => hash !== null).map(([name]) => name));
  const providers = new Map();
  const manifests = new Map();
  for (const unit of units) {
    if (!unit.manifest) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, unit.manifest), 'utf8'));
      manifests.set(unit.id, manifest);
      for (const service of manifest.provides ?? []) {
        if (typeof service !== 'string') { reasons.add(`unknown-service:${unit.id}`); continue; }
        const list = providers.get(service) ?? []; list.push(unit.id); providers.set(service, list);
      }
    } catch { reasons.add(`manifest-unavailable:${unit.id}`); }
  }
  for (const unit of units) {
    const manifest = manifests.get(unit.id);
    for (const service of [...(manifest?.requires ?? []), ...(manifest?.optional ?? [])]) {
      const candidates = providers.get(service) ?? [];
      const bound = unit.bindings?.[service];
      if (bound) {
        if (!candidates.includes(bound)) reasons.add(`unresolved-binding:${unit.id}:${service}`);
        else addEdge(unit.id, bound, 'binding');
      } else for (const provider of candidates) addEdge(unit.id, provider, 'service');
      if (!candidates.length && (manifest.requires ?? []).includes(service) && !externalServices.includes(service)) reasons.add(`unresolved-service:${unit.id}:${service}`);
    }
    for (const [service, provider] of Object.entries(unit.bindings ?? {})) {
      if (!(manifest?.requires ?? []).includes(service) && !(manifest?.optional ?? []).includes(service)) reasons.add(`undeclared-binding:${unit.id}:${service}`);
      if (!byId.has(provider)) reasons.add(`unknown-provider:${provider}`);
    }
    for (const input of [...(unit.runtimeInputs ?? []), ...(unit.dynamicInputs ?? [])]) {
      const matches = [...fileSet].filter(file => file === input || file.startsWith(`${input}/`));
      if (!matches.length) reasons.add(`missing-declared-dependency:${unit.id}:${input}`);
      for (const file of matches) {
        const targets = owners(file);
        if (!targets.length) reasons.add(`unowned-dependency:${file}`);
        for (const provider of targets) addEdge(unit.id, provider.id, 'declared-input');
      }
    }
  }
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  for (const file of fileSet) {
    if (/\.(?:vue|svelte|astro|html|mdx|css|scss|less)$/.test(file)) {
      reasons.add(`unsupported-source:${file}`);
      continue;
    }
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue;
    const consumers = owners(file);
    if (!consumers.length) { reasons.add(`unowned-code:${file}`); continue; }
    const source = ts.createSourceFile(file, await fs.readFile(path.join(sourceRoot, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const references = [];
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) references.push(node.moduleSpecifier);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) references.push(node.moduleReference.expression);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) references.push(node.arguments[0]);
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1]?.getText(source) === 'import.meta.url') references.push(node.arguments[0]);
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'import.meta.glob' && !consumers.every(unit => unit.dynamicInputs?.length)) reasons.add(`dynamic-discovery:${file}`);
      ts.forEachChild(node, walk);
    }
    walk(source);
    if (source.parseDiagnostics.length) reasons.add(`parse-error:${file}`);
    for (const reference of references) {
      if (!reference || !ts.isStringLiteralLike(reference)) { if (!consumers.every(unit => unit.dynamicInputs?.length)) reasons.add(`dynamic-dependency:${file}`); continue; }
      const specifier = reference.text;
      if (builtins.has(specifier)) {
        // createRequire can be imported under an alias or acquired by import()/require().
        if (['module', 'node:module'].includes(specifier) && !consumers.every(unit => unit.dynamicInputs?.length)) reasons.add(`dynamic-module-loader:${file}`);
        if (['fs', 'fs/promises', 'node:fs', 'node:fs/promises'].includes(specifier) && !consumers.every(unit => unit.runtimeInputs?.length)) reasons.add(`runtime-filesystem:${file}`);
        continue;
      }
      let dependency;
      if (specifier.startsWith('.')) {
        const relative = path.relative(sourceRoot, path.resolve(sourceRoot, path.dirname(file), specifier)).replaceAll('\\', '/');
        const stem = relative.replace(/\.(?:mjs|cjs|js|jsx)$/, '');
        dependency = [relative, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.js'].map(ext => stem + ext)].find(name => fileSet.has(name));
      }
      if (!dependency) { reasons.add(`unresolved-import:${file}:${specifier}`); continue; }
      const targets = owners(dependency);
      if (!targets.length) reasons.add(`unowned-dependency:${dependency}`);
      for (const consumer of consumers) for (const target of targets) addEdge(consumer.id, target.id, 'import');
    }
  }
  const currentFiles = new Map(files);
  const previousFiles = new Map(baseline?.files ?? []);
  const changes = [...new Set([...currentFiles.keys(), ...previousFiles.keys()])].filter(file => currentFiles.get(file) !== previousFiles.get(file)).sort();
  const affected = new Set();
  if (!baseline) reasons.add('baseline-missing');
  for (const file of changes) {
    const previousOwners = (baseline?.units ?? []).filter(unit => owns(unit, file));
    const matching = [...owners(file), ...previousOwners];
    if (!matching.length) reasons.add(`unowned-change:${file}`);
    for (const unit of matching) affected.add(unit.id);
  }
  // Changes to service bindings/unit definitions themselves invalidate their consumers.
  for (const unit of units) if (encode(unit) !== encode(baseline?.units?.find(previous => previous.id === unit.id))) affected.add(unit.id);
  const combinedEdges = [...edges.values(), ...(baseline?.edges ?? [])];
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of combinedEdges) if (affected.has(edge.provider) && !affected.has(edge.consumer)) { affected.add(edge.consumer); changed = true; }
  }
  const declaredTests = [...new Set(units.flatMap(unit => unit.tests))].sort();
  const missingCoverage = declaredTests.filter(test => !fullTests.includes(test));
  if (missingCoverage.length) reasons.add('declared-tests-missing-from-full-run');
  const expanded = reasons.size > 0;
  const selectedUnits = units.filter(unit => expanded || affected.has(unit.id)).map(unit => unit.id).sort();
  const selectedTests = [...new Set(expanded ? [...fullTests, ...declaredTests] : units.filter(unit => selectedUnits.includes(unit.id)).flatMap(unit => unit.tests))].sort();
  return { mode: 'shadow', changes, selectedUnits, selectedTests, fullTests, missingCoverage, expanded, reasons: [...reasons].sort(),
    snapshot: structuredClone({ files, units, edges: [...edges.values()] }) };
}

function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.isAbsolute(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid input path: ${value}`);
  return value;
}

/** Hash exact files and directory membership; symlinks are not frozen inputs. */
export async function fingerprintFiles(root, selections) {
  const files = new Map();
  async function visit(relative) {
    relativeFile(relative);
    const target = path.join(root, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Materialize linked input before verification: ${relative}`);
    if (stat.isDirectory()) {
      files.set(`${relative}/`, null);
      for (const name of (await fs.readdir(target)).sort()) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) files.set(relative, digest(await fs.readFile(target)));
    else throw new Error(`Unsupported verification input: ${relative}`);
  }
  for (const selection of selections) await visit(selection);
  const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
  return { entries, sha256: digest(encode(entries)) };
}

/** Check build contents without treating an unsigned build receipt as release permission. */
export async function inspectPluginBuild(candidateRoot) {
  const evidence = JSON.parse(await fs.readFile(path.join(candidateRoot, 'build-evidence.json'), 'utf8'));
  if (evidence.kind !== 'plugin-build' || !Array.isArray(evidence.artifacts?.files) || !evidence.artifacts.files.length) throw new Error('Missing plugin build evidence.');
  const declared = evidence.artifacts.files;
  const roots = [...new Set(declared.map(item => {
    const parts = relativeFile(item.path).split('/');
    return parts[0] === 'packages' ? parts.slice(0, 3).join('/') : parts[0];
  }))];
  const actual = await fingerprintFiles(candidateRoot, roots);
  const files = actual.entries.filter(([, hash]) => hash !== null).map(([name, sha256]) => ({ path: name, sha256 }));
  if (encode(files) !== encode(declared) || digest(encode(files)) !== evidence.artifacts.sha256) throw new Error('Plugin candidate contents differ from build evidence.');
  return { candidateSha256: evidence.artifacts.sha256, roots };
}

/** Reuse the original built artifact owners from the formal backend build.
 * Their exact bytes are frozen per verification; no validation schema is copied.
 */
async function inspectPublicationArtifact(candidateRoot, artifactKind, expected, tempRoot, signal) {
  if (artifactKind === 'plugin-build') return { ...await inspectPluginBuild(candidateRoot), artifactKind };
  if (!['source-patch', 'web-patch'].includes(artifactKind) || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Declare source-patch/web-patch and its original artifact SHA-256.');
  const ownerFiles = artifactKind === 'source-patch'
    ? ['dist/plugin-kernel/hotPatchCandidateStore.js', 'dist/plugin-kernel/hotPatchResourceStore.js']
    : ['dist/manager/webPatchCatalog.js', 'dist/plugin-kernel/automaticCodeRuntime.js', 'dist/plugin-kernel/hotPatchIterator.js'];
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const ownerBefore = await fingerprintFiles(repository, ownerFiles);
  const compiled = path.join(tempRoot, 'artifact-owner');
  const ownerInputs = [];
  await fs.mkdir(compiled);
  await fs.writeFile(path.join(compiled, 'package.json'), '{"type":"module"}');
  for (const file of ownerFiles) {
    signal?.throwIfAborted();
    const bytes = await fs.readFile(path.join(repository, file));
    const target = path.join(compiled, file);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    ownerInputs.push({ path: file, sha256: digest(bytes) });
  }
  if (ownerBefore.sha256 !== (await fingerprintFiles(repository, ownerFiles)).sha256
      || ownerInputs.some(file => new Map(ownerBefore.entries).get(file.path) !== file.sha256)) throw new Error('Built artifact owner changed while freezing verification.');
  const module = await import(pathToFileURL(path.join(compiled, ownerFiles[0])).href);
  if (artifactKind === 'source-patch') {
    await new module.HotPatchCandidateStore(candidateRoot).read(expected);
    return { artifactKind, candidateSha256: expected, roots: [`${expected}.json`], ownerInputs };
  }
  const manifest = await module.verifyWebPatch(candidateRoot, expected, signal);
  return { artifactKind, candidateSha256: expected, roots: ['manifest.json', ...manifest.files.map(file => file.path)], ownerInputs };
}

function verificationEnvironment() {
  const env = {};
  // Public OS/user directory inputs only; do not inherit credentials or NODE_OPTIONS.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function runTests(root, tests, candidateRoot, environment, signal) {
  return new Promise(resolve => {
    const env = { ...environment, RABI_CANDIDATE_ROOT: candidateRoot, RABI_PLUGIN_CANDIDATE_ROOT: candidateRoot };
    let child;
    let output = '';
    // Keep the Node runner in one owned process so cancellation also ends its tests.
    try { child = spawn(process.execPath, ['--test', '--test-isolation=none', ...tests], { cwd: root, env, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ status: signal?.aborted ? 'cancelled' : 'failed', error: error.message }); return; }
    let failure;
    const collect = chunk => { output = (output + chunk.toString()).slice(-16384); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { failure = error; });
    child.on('close', (code, termSignal) => resolve({ status: signal?.aborted ? 'cancelled' : code === 0 && !failure ? 'passed' : 'failed', exitCode: code, signal: termSignal, output, ...(failure ? { error: failure.message } : {}) }));
  });
}

/** Local developer tool only. All inputs are copied before execution. Cache eligibility
 * is an explicit reviewed declaration, never inferred from a passing test or directory name.
 * External capabilities, lifecycle and post-activation readback must run independently.
 */
export async function verifyPluginCandidate({ sourceRoot, candidateRoot, cacheRoot, inputs, tests, deterministic = false, completeInputClosure = false, impact: impactConfig, artifactKind = 'plugin-build', artifactSha256, signal }) {
  if (!Array.isArray(inputs) || !inputs.length || !Array.isArray(tests) || !tests.length) throw new Error('Declare verification inputs and Node test files.');
  inputs.forEach(relativeFile); tests.forEach(relativeFile);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-plugin-verification-'));
  const frozenSource = path.join(temp, 'source');
  const frozenCandidate = path.join(temp, 'candidate');
  try {
    const before = await fingerprintFiles(sourceRoot, inputs);
    await fs.mkdir(frozenSource);
    for (const input of inputs) {
      await fs.mkdir(path.dirname(path.join(frozenSource, input)), { recursive: true });
      await fs.cp(path.join(sourceRoot, input), path.join(frozenSource, input), { recursive: true, verbatimSymlinks: true });
    }
    const frozenInputs = await fingerprintFiles(frozenSource, inputs);
    if (before.sha256 !== frozenInputs.sha256 || before.sha256 !== (await fingerprintFiles(sourceRoot, inputs)).sha256) throw new Error('Verification inputs changed while freezing.');
    for (const test of tests) if (!frozenInputs.entries.some(([name, hash]) => name === test && hash)) throw new Error(`Test is outside declared inputs: ${test}`);
    const impact = impactConfig ? await analyzeVerificationImpact({ ...impactConfig, sourceRoot: frozenSource, files: frozenInputs.entries, fullTests: tests }) : undefined;
    if (artifactKind === 'source-patch') {
      if (!/^[a-f0-9]{64}$/.test(artifactSha256 ?? '')) throw new Error('Declare the original source candidate SHA-256.');
      await fs.mkdir(frozenCandidate);
      await fs.cp(path.join(candidateRoot, `${artifactSha256}.json`), path.join(frozenCandidate, `${artifactSha256}.json`), { verbatimSymlinks: true });
    } else await fs.cp(candidateRoot, frozenCandidate, { recursive: true, verbatimSymlinks: true });
    const candidate = await inspectPublicationArtifact(frozenCandidate, artifactKind, artifactSha256, temp, signal);
    // Expose only the evidenced artifact closure. A targeted output may also hold
    // unrelated packages or build receipts, neither of which belongs to this test.
    const testedCandidate = path.join(temp, 'tested-candidate');
    await fs.mkdir(testedCandidate);
    for (const root of candidate.roots) {
      await fs.mkdir(path.dirname(path.join(testedCandidate, root)), { recursive: true });
      await fs.cp(path.join(frozenCandidate, root), path.join(testedCandidate, root), { recursive: true });
    }
    const candidateInputs = await fingerprintFiles(testedCandidate, await fs.readdir(testedCandidate));
    const environment = verificationEnvironment();
    const environmentSha256 = digest(encode(environment));
    const toolchain = { node: process.version, platform: process.platform, arch: process.arch, executable: digest(await fs.readFile(process.execPath)), verifier: digest(await fs.readFile(new URL(import.meta.url))), typescript: digest(await fs.readFile(createRequire(import.meta.url).resolve('typescript'))) };
    const key = digest(encode({ inputs: frozenInputs.sha256, artifactKind, candidate: candidate.candidateSha256, candidateInputs: candidateInputs.sha256, artifactOwner: candidate.ownerInputs, tests, toolchain, environmentSha256, impactConfig }));
    const reusable = deterministic && completeInputClosure;
    const cachePath = cacheRoot && path.join(cacheRoot, `${key}.json`);
    if (reusable && cachePath && !signal?.aborted) {
      try {
        const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
        const { checksum, ...receipt } = cached;
        if (checksum === digest(encode(receipt)) && receipt.key === key && receipt.status === 'passed') return { ...receipt, reused: true };
      } catch { /* A missing, corrupt or inaccessible optional cache requires execution. */ }
    }
    const started = performance.now();
    const result = await runTests(frozenSource, tests, testedCandidate, environment, signal);
    // Tests must not change the input or the candidate they claim to cover.
    const unchanged = frozenInputs.sha256 === (await fingerprintFiles(frozenSource, inputs)).sha256;
    let candidateUnchanged = false;
    try { candidateUnchanged = (await fingerprintFiles(testedCandidate, await fs.readdir(testedCandidate))).sha256 === candidateInputs.sha256; } catch { /* Failed evidence is not reusable. */ }
    const receipt = { schemaVersion: 1, kind: artifactKind === 'plugin-build' ? 'plugin-verification' : 'publication-verification', artifactKind, mode: 'shadow', key, candidateSha256: candidate.candidateSha256, inputSha256: frozenInputs.sha256, coveredArtifactRoots: candidate.roots, artifactOwner: candidate.ownerInputs, inputs: frozenInputs, tests, toolchain, environmentSha256, ...(impact ? { impact } : {}), ...result,
      status: unchanged && candidateUnchanged ? result.status : 'inputs-mutated', reusable: reusable && unchanged && candidateUnchanged && result.status === 'passed', reused: false, elapsedMs: performance.now() - started,
      limitation: 'local deterministic tests only; not release admission or runtime acceptance' };
    if (receipt.reusable && cachePath) {
      const staging = `${cachePath}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(cacheRoot, { recursive: true });
        await fs.writeFile(staging, encode({ ...receipt, checksum: digest(encode(receipt)) }));
        await fs.rename(staging, cachePath);
      } catch (error) { receipt.cacheWriteError = error.code ?? 'cache-write-failed'; }
      finally { await fs.rm(staging, { force: true }).catch(() => {}); }
    }
    return receipt;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
