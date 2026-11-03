import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = path.resolve(process.argv[2] || fileURLToPath(new URL("../", import.meta.url)));
const typescript = createRequire(path.join(repositoryRoot, "package.json"))("typescript");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-remote-create-contract-"));
const owned = ["src/agentAdapters/instanceManagement.ts","src/agentThreads.ts","src/callerCreationMetadata.ts","src/codexTaskIdentity.ts","src/codexThreadCreationReservations.ts","src/manager/controlPlaneRoutes.ts","src/manager/instanceThreadRouting.ts","src/manager/lanAgentRegistry.ts","src/manager/remoteCodexCreate.ts","src/manager/nativeHttpTestClient.ts"];
try {
  fs.mkdirSync(path.join(fixtureRoot, "compiled"), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "compiled/package.json"), '{"type":"module"}');
  for (const relative of owned) {
    const input = fs.readFileSync(path.join(repositoryRoot, relative), "utf8");
    const output = typescript.transpileModule(input, { compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ES2022 } }).outputText;
    const ast = typescript.createSourceFile(relative, output, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS);
    const changes = [];
    for (const node of ast.statements) {
      if (!(typescript.isImportDeclaration(node) || typescript.isExportDeclaration(node)) || !node.moduleSpecifier || !typescript.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith(".")) continue;
      const local = path.resolve(fixtureRoot, "compiled", path.dirname(relative.slice(4)), node.moduleSpecifier.text);
      const isOwned = owned.some(p => path.resolve(fixtureRoot, "compiled", p.slice(4).replace(/\.ts$/, ".js")) === local);
      const target = isOwned ? local : path.resolve(repositoryRoot, "dist", path.dirname(relative.slice(4)), node.moduleSpecifier.text);
      changes.push({ start: node.moduleSpecifier.getStart(ast), end: node.moduleSpecifier.end, text: JSON.stringify(pathToFileURL(target).href) });
    }
    let result = output;
    for (const change of changes.reverse()) result = result.slice(0, change.start) + change.text + result.slice(change.end);
    const target = path.join(fixtureRoot, "compiled", relative.slice(4).replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result);
  }
  const fixtureSource = path.join(repositoryRoot, "scripts/fixtures/remote-codex-create");
  for (const name of ["orchestration.test.mjs", "http-sdk.test.mjs", "restart-replay.mjs"]) fs.copyFileSync(path.join(fixtureSource, name), path.join(fixtureRoot, name));
  const childEnvironment = { ...process.env, RABI_REMOTE_CREATE_SOURCE_ROOT: repositoryRoot, RABI_REMOTE_CREATE_FIXTURE_ROOT: fixtureRoot };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test-reporter=tap", "--import", pathToFileURL(path.join(repositoryRoot, "scripts/test-manager-runtime-env.mjs")).href, "--experimental-test-module-mocks", "--unhandled-rejections=strict", "--test-concurrency=1", "--test", "orchestration.test.mjs", "http-sdk.test.mjs"], {
    cwd: fixtureRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000,
    env: childEnvironment
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const count = name => {
    const prefix = "# " + name + " ";
    const line = (result.stdout || "").split(String.fromCharCode(10)).find(value => value.startsWith(prefix));
    const value = line === undefined ? NaN : Number(line.slice(prefix.length).trim());
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Remote create test runner did not report its " + name + " count.");
    return value;
  };
  const summary = { tests: count("tests"), pass: count("pass"), fail: count("fail"), cancelled: count("cancelled"), skipped: count("skipped"), todo: count("todo") };
  if (result.status !== 0 || summary.tests < 1 || summary.pass < 1 || summary.fail || summary.cancelled) {
    throw new Error("Remote create test runner did not report a successful non-empty suite: " + JSON.stringify(summary));
  }
  process.stdout.write("REMOTE_CODEX_CREATE_TEST_RESULT " + JSON.stringify(summary) + "\n");
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
