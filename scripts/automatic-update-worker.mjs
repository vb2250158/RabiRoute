import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
import { compileAutomaticCode } from "./lib/automatic-code-compiler.mjs";
import { captureAutomaticInputs, automaticInputsUnchanged } from "./lib/automatic-update-inputs.mjs";
import { captureAutomaticWebInputs, buildIsolatedWebUpdate, removeIsolatedWebWorkspace } from "./lib/automatic-web-build.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
export async function prepareAutomaticCodeUpdate({ sourceRoot, packageRoot }) {
  const catalog = JSON.parse(await fs.readFile(path.join(packageRoot, "dist/automatic-code/catalog.json"), "utf8"));
  if (!catalog.inputHashes) throw new Error("The installed compiler baseline has no frozen input inventory; install a baseline with inventory support.");
  const input = await captureAutomaticInputs(sourceRoot, ["src", "package.json", "package-lock.json", "tsconfig.json"]);
  const changes = [];
  const reasons = [];
  const snapshots = new Map();
  for (const entry of catalog.modules) {
    const filename = path.join(sourceRoot, entry.sourcePath);
    const source = input.files.get(entry.sourcePath)?.toString("utf8");
    if (source === undefined) { reasons.push({ file: entry.sourcePath, reason: "A baseline module was removed; its import graph requires a controlled switch." }); continue; }
    if (hash(source) === entry.sourceHash) continue;
    if (entry.protectedReason) { reasons.push({ file: entry.sourcePath, reason: entry.protectedReason }); continue; }
    changes.push({ entry, filename, source });
  }
  for (const [relative, bytes] of input.files) {
    snapshots.set(path.resolve(sourceRoot, relative).replaceAll("\\", "/").toLowerCase(), bytes.toString("utf8"));
    if (relative.startsWith("src/") && relative.endsWith(".ts") && !relative.endsWith(".test.ts") && !relative.endsWith(".d.ts") && !Object.hasOwn(catalog.inputHashes, relative)) {
      reasons.push({ file: relative, reason: "A new executable module has no running import, state or lifecycle owner; source-patch plugin modules use their discovery contract, other initialization changes require a controlled switch." });
    }
  }
  for (const filename of ["package.json", "package-lock.json", "tsconfig.json"]) {
    const expected = catalog.inputHashes[filename];
    const actual = input.files.get(filename);
    if (expected !== (actual === undefined ? undefined : hash(actual))) reasons.push({ file: filename, reason: "Compiler or package dependencies changed; a controlled switch is required." });
  }
  if (reasons.length) return { state: "requires_switch", reasons };
  const definitions = catalog.modules.filter(entry => entry.definition).map(entry => entry.definition);
  if (changes.length) {
    const configFile = path.join(sourceRoot, "tsconfig.json");
    const config = ts.readConfigFile(configFile, filename => snapshots.get(path.resolve(filename).replaceAll("\\", "/").toLowerCase()));
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const configuration = ts.parseJsonConfigFileContent(config.config, ts.sys, sourceRoot);
    if (configuration.errors.length) throw new Error(ts.flattenDiagnosticMessageText(configuration.errors[0].messageText, "\n"));
    const options = { ...configuration.options, noEmit: false, incremental: false };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    host.readFile = filename => {
      const normalized = path.resolve(filename).replaceAll("\\", "/").toLowerCase();
      return snapshots.has(normalized) ? snapshots.get(normalized) : read(filename);
    };
    const program = ts.createProgram(configuration.fileNames, options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 12), { getCurrentDirectory: () => sourceRoot, getCanonicalFileName: name => name, getNewLine: () => "\n" }));
    for (const change of changes) {
      let emitted;
      const sourceFile = program.getSourceFile(change.filename);
      if (!sourceFile) throw new Error(`Changed module is outside the frozen compiler program: ${change.entry.sourcePath}`);
      program.emit(sourceFile, (filename, contents) => { if (filename.endsWith(".js")) emitted = contents; });
      if (emitted === undefined) throw new Error(`No JavaScript output for ${change.entry.sourcePath}`);
      const definition = compileAutomaticCode(emitted, change.entry.definition.moduleId).definition;
      if (definition.shapeHash !== change.entry.definition.shapeHash) {
        reasons.push({ file: change.entry.sourcePath, reason: "Imports, exports, signatures, initialization or unsupported method bodies changed.", unsupported: definition.unsupported });
      }
      definitions[definitions.findIndex(entry => entry.moduleId === definition.moduleId)] = definition;
    }
  }
  if (!await automaticInputsUnchanged(sourceRoot, input)) return { state: "superseded", reasons: [] };
  if (reasons.length) return { state: "requires_switch", reasons };
  return { state: "prepared", definitions, digest: hash(JSON.stringify(definitions)), inputDigest: input.digest, changedFiles: changes.map(change => change.entry.sourcePath) };
}

export async function prepareAutomaticUpdate(options) {
  const code = await prepareAutomaticCodeUpdate(options);
  if (code.state !== "prepared") return code;
  const inputs = await captureAutomaticWebInputs(options.sourceRoot);
  if (inputs.webDigest === options.webInputDigest) return { ...code, webInputDigest: inputs.webDigest };
  const web = await buildIsolatedWebUpdate({ ...options, expectedInputDigest: inputs.webDigest });
  if (web.state !== "prepared") return web;
  const current = await captureAutomaticInputs(options.sourceRoot, ["src", "package.json", "package-lock.json", "tsconfig.json"]);
  if (current.digest !== code.inputDigest) {
    await removeIsolatedWebWorkspace(options.workRoot, web.workspace);
    return { state: "superseded", reasons: [] };
  }
  return { ...code, web, webInputDigest: web.inputDigest };
}

if (parentPort) {
  const controller = new AbortController();
  parentPort.on("message", message => { if (message === "cancel") controller.abort(new Error("Automatic build cancelled.")); });
  try { parentPort.postMessage(await prepareAutomaticUpdate({ ...workerData, signal: controller.signal })); }
  catch (error) { parentPort.postMessage({ state: "failed", reasons: [{ reason: error instanceof Error ? error.message : String(error) }] }); }
  finally { parentPort.close(); }
}
