import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repositoryRoot, "src");
const reviewedTestFixtures = ["src/manager/pluginCatalogOperations.fixture.ts", "src/manager/diagnosticsCandidate.fixture.ts"];

const mutationPattern = /\bfs(?:\.promises)?\.(?:writeFile|appendFile|rename|unlink|rm|copyFile|writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|copyFileSync|futimesSync|utimesSync|createWriteStream)\s*\(/;
const auditPattern = /\bauditRecordingArchiveMutation\s*\(|\brecordDataMutationAudit\s*\(|\batomicWriteFileSync\s*\(|\bappendAdapterLog\s*\(/;

const infrastructureExclusions = new Map([
  ...reviewedTestFixtures.map(file => [file, "test-only helper creates/removes private os.tmpdir() plugin packages and fixture resources; no production business data; test-only imports are enforced below"]),
  ["src/manager/developerCandidateProvenance.ts", "hash-bound local build-origin metadata in the existing candidate store; source/Web publication commits and failures retain their owning service audit callbacks; no persona or business records"],
  ["src/personaChatHistoryIndex.ts", "rebuildable SQLite projection of the authoritative chat ledger; only deletes its derived index on corruption; original ledger mutations remain audited by personaChatHistory"],
  ["src/plugin-kernel/pluginPackageLoadWorker.ts", "dependency-free Loader worker removes only validated UUID staging directories under the original runtime cache, with plain-directory root checks; no user records"],
  ["src/plugin-runtime-host/asyncOutcomeArchive.ts", "original RPC uncertainty evidence sink; preserves sanitized request identity and first/current outcome metadata with readback; no args, response bodies or native business mutation; authoritative native receipts remain with original owners"],
  ["src/roleLifecycle.ts", "role coordination locks/work leases and atomic JSON publication primitive; role configuration and lifecycle business commits/failures are audited by roleConfigurationRoutes"],
  ["src/manager/companionFrameDelivery.ts", "generation-owned temporary reduced-frame attachment leases; exclusive creation, bounded size and lifetime; no persistent persona or message state"],
  ["src/linuxProcessLease.ts", "kernel ownership lease descriptor and atomic temporary file; no persona, message or business state"],
  ["src/markdownImage.ts", "isolated temporary browser profile cleanup after bounded image rendering; send receipts remain owned and audited by the send pipeline"],
  ["src/integrations/xiaomiHome/vacuumVideoWorker.ts", "IPC-owned native transport supervisor removes its temporary environment-reference config; session lifecycle is recorded by the owning vacuum video service"],
  ["src/planPageCatalogCheckpoint.ts", "disposable plan projection cache; source JSON remains authoritative and is reconciled on restore; atomic temporary publication does not mutate business records"],
  ["src/manager/sourcePatchService.ts", "source patch publication journals and recovery fences; publication events use the injected audit callback"],
  ["src/manager/webPatchService.ts", "immutable Web bundle cache; committed state emits web_patch_committed through the injected audit callback"],
  ["src/manager/webPatchCatalog.ts", "content-addressed Web artifacts and atomic patch-state writer owned by WebPatchService"],
  ["src/manager/speechStableExecutable.ts", "rebuildable installed speech executable with stable firewall identity; fsync and atomic rename, no persona or message state"],
  ["src/manager/roleSkillDownloadRoutes.ts", "private temporary ZIP leases only, no persona or message state; unconfirmed worker exit retains quarantine until confirmed release; failed cleanup retains admission"],
  ["src/plugin-kernel/hotPatchBundleJournal.ts", "dependency-free hot patch transaction journal with fsync and exclusive recovery locks"],
  ["src/codexAppServerClient.ts", "app-server stderr log sink"],
  ["src/managerInstanceLock.ts", "Manager ownership lock and lease files"],
  ["src/managerRuntimeDiagnostics.ts", "runtime diagnostic log sink"],
  ["src/marvis.ts", "temporary prompt file removed after process execution"],
  ["src/plan-storage/internal/lease.ts", "plan storage coordination locks and lease heartbeats"],
  ["src/manager/operationalLog.ts", "unified operational log sink and retention"],
  ["src/manager/performanceStore.ts", "performance telemetry log sink and retention"],
  ["src/plugin-kernel/packageLoader.ts", "immutable rebuildable plugin runtime cache owned by the dependency-free plugin kernel"],
  ["src/manager/routeCatalogTransaction.ts", "isolated transaction worker audited by routeCatalogStartupLifecycle"]
]);

function sourceFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) output.push(absolute);
  }
  return output;
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).replaceAll("\\", "/");
}

// Keep the mutation scanner above unchanged. This separate dependency check also
// includes tests and JavaScript entry points, so the reviewed helper cannot leak
// into a runtime through a re-export, dynamic import, require or path alias.
function importSourceFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist", "build", ".git", ".gradle", ".cxx"].includes(entry.name)) output.push(...importSourceFiles(absolute));
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

const compilerOptions = ts.parseJsonConfigFileContent(
  ts.readConfigFile(path.join(repositoryRoot, "tsconfig.json"), ts.sys.readFile).config,
  { ...ts.sys, readDirectory: () => [] }, repositoryRoot
).options;
const canonicalModule = filename => {
  const absolute = fs.realpathSync(filename);
  return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
};
const reviewedFixtureModules = new Set(reviewedTestFixtures.map(file => canonicalModule(path.join(repositoryRoot, file))));
const resolutionCache = ts.createModuleResolutionCache(repositoryRoot,
  filename => ts.sys.useCaseSensitiveFileNames ? filename : filename.toLowerCase(), compilerOptions);

function fixtureImportConsumers(sources) {
  return sources.filter(({ filename, source }) => ts.preProcessFile(source, true, true).importedFiles.some(({ fileName }) => {
    const resolved = ts.resolveModuleName(fileName, filename, compilerOptions, ts.sys, resolutionCache).resolvedModule;
    return resolved && reviewedFixtureModules.has(canonicalModule(resolved.resolvedFileName));
  })).map(({ filename }) => relativePath(filename)).sort();
}

function assertOnlyTestConsumers(consumers) {
  const production = consumers.filter(filename => !filename.endsWith(".test.ts"));
  assert.deepEqual(production, [], `Reviewed temporary test fixture cannot be imported by production code:\n${production.join("\n")}`);
}

test("reviewed temporary fixtures are consumed only by TypeScript tests", t => {
  const sources = ["src", "apps", "plugins", "packages", "scripts"]
    .flatMap(directory => importSourceFiles(path.join(repositoryRoot, directory)))
    .map(filename => ({ filename, source: fs.readFileSync(filename, "utf8") }));
  for (const fixture of reviewedTestFixtures) {
    const relevant = sources.filter(({ source }) => source.includes(path.basename(fixture, ".ts")));
    assert.ok(fixtureImportConsumers(relevant).length > 0, `Reviewed fixture must have test consumers: ${fixture}`);
  }
  const consumers = fixtureImportConsumers(sources);
  assert.ok(consumers.length > 0, "The reviewed fixture must have real test consumers; remove a stale exclusion.");
  assertOnlyTestConsumers(consumers);
  t.diagnostic(`Reviewed fixture consumers: ${consumers.join(", ")}`);
});

test("reviewed fixture import guard rejects production imports and re-exports without excluding other fixtures", () => {
  const filename = path.join(sourceRoot, "manager", "fixtureImportProbe.ts");
  for (const fixture of reviewedTestFixtures) {
  const specifier = `./${path.basename(fixture, ".ts")}.js`;
  for (const source of [
    `import { deferred } from "${specifier}";`,
    `export { deferred } from "${specifier}";`,
    `export * from "${specifier}";`,
    `const helper = await import("${specifier}");`,
    `const helper = require("${specifier}");`,
    `import helper = require("${specifier}");`,
    `type Helper = typeof import("${specifier}");`,
    `import { deferred } from "${fixture.replace(/\.ts$/, "")}";`
  ]) {
    const consumers = fixtureImportConsumers([{ filename, source }]);
    assert.deepEqual(consumers, ["src/manager/fixtureImportProbe.ts"], source);
    assert.throws(() => assertOnlyTestConsumers(consumers), /cannot be imported by production code/, source);
  }
  const testConsumer = fixtureImportConsumers([{ filename: filename.replace(".ts", ".test.ts"), source: `import "${specifier}";` }]);
  assert.doesNotThrow(() => assertOnlyTestConsumers(testConsumer));
  assert.deepEqual(fixtureImportConsumers([{ filename, source: `// import "${specifier}";\nconst example = '${specifier}';` }]), []);
  }
  assert.equal(infrastructureExclusions.has("src/manager/unreviewed.fixture.ts"), false);
});

test("production file mutations are audited or explicitly classified as infrastructure", () => {
  const directMutationFiles = sourceFiles(sourceRoot)
    .map(absolute => ({ absolute, relative: relativePath(absolute) }))
    .filter(file => !file.relative.startsWith("src/acceptance/"))
    .filter(file => mutationPattern.test(fs.readFileSync(file.absolute, "utf8")));

  const uncovered = directMutationFiles
    .filter(file => {
      const source = fs.readFileSync(file.absolute, "utf8");
      return !auditPattern.test(source) && !infrastructureExclusions.has(file.relative);
    })
    .map(file => file.relative);

  assert.deepEqual(uncovered, [], `Direct data mutations need recordDataMutationAudit(), atomicWriteFileSync(), or a reviewed infrastructure exclusion:\n${uncovered.join("\n")}`);

  const directPaths = new Set(directMutationFiles.map(file => file.relative));
  const staleExclusions = [...infrastructureExclusions.keys()].filter(file => !directPaths.has(file));
  assert.deepEqual(staleExclusions, [], `Remove stale mutation coverage exclusions:\n${staleExclusions.join("\n")}`);
});
