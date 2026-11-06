import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { generatePluginHostApi } from "./generate-plugin-host-api.mjs";

test("published host types reuse Node builtins and declare only actual npm dependencies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-host-types-"));
  try {
    const write = async (relative, content) => {
      const file = path.join(root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
    };
    await write("tsconfig.json", { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src" } });
    await write("package.json", { type: "module", dependencies: { ws: "^8.18.0" }, devDependencies: { "@types/node": "^22.10.7", "@types/ws": "^8.5.13" } });
    await write("src/contract.ts", "export function accept(): void {}\n");
    await write("plugins/contracts/host-api/package.json", { name: "@rabiroute/host-api", version: "1.0.0", type: "module" });
    const declaration = 'import type { IncomingMessage } from "http";\nimport type { Server } from "node:net";\nimport type { WebSocket } from "ws";\nexport declare function accept(request: IncomingMessage, server: Server, socket: WebSocket): void;\n';
    await write("dist/host-api-types/contract.d.ts", declaration);
    const result = await generatePluginHostApi(root, { moduleIds: ["contract"] });
    assert.equal(result.declarations, 1);
    const published = JSON.parse(await fs.readFile(path.join(root, "plugins/contracts/host-api/package.json"), "utf8"));
    assert.deepEqual(published.dependencies, { "@types/node": "^22.10.7", ws: "^8.18.0", "@types/ws": "^8.5.13" });
    assert.equal(await fs.readFile(path.join(root, "plugins/contracts/host-api/types/src/contract.d.ts"), "utf8"), declaration);
    const signatures = JSON.parse(await fs.readFile(path.join(root, "plugins/contracts/host-api/modules.json"), "utf8"));
    assert.deepEqual(signatures.modules.contract.exports, ["accept"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function completeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-host-api-publication-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (relative, contents) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  };
  await write("tsconfig.json", { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src" } });
  await write("package.json", { type: "module", devDependencies: { "@types/node": "^22.10.7" } });
  await write("src/contract.ts", "export function accept(): void {}\n");
  await write("dist/host-api-types/contract.d.ts", "export declare function accept(): void;\n");
  const output = "plugins/contracts/host-api";
  await write(output + "/package.json", { name: "@rabiroute/host-api", version: "1.0.0", type: "module" });
  await write(output + "/README.md", "Maintained documentation bytes\n");
  await write(output + "/requested-modules.json", ["contract"]);
  await generatePluginHostApi(root, { moduleIds: ["contract"] });
  const snapshot = async () => {
    const files = {};
    const scan = async (directory, relative = "") => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name), key = relative + entry.name;
        if (entry.isDirectory()) await scan(file, key + "/");
        else files[key] = (await fs.readFile(file)).toString("base64");
      }
    };
    await scan(path.join(root, output));
    return files;
  };
  return { root, write, output: path.join(root, output), snapshot };
}

test("a missing declaration keeps the complete previous API package unchanged", async t => {
  const f = await completeFixture(t), before = await f.snapshot();
  await f.write("src/new-contract.ts", "export const newValue = 2;\n");
  await assert.rejects(generatePluginHostApi(f.root, { moduleIds: ["contract", "new-contract"] }), /Emit the host declaration closure/);
  assert.deepEqual(await f.snapshot(), before);
});

test("unknown or local declaration dependencies keep previous signatures, metadata and types", async t => {
  const f = await completeFixture(t), before = await f.snapshot();
  await f.write("dist/host-api-types/contract.d.ts", 'import type { Missing } from "new-package"; export declare const changed: Missing;\n');
  for (const version of [undefined, "file:../private", "workspace:*"]) {
    await f.write("package.json", { type: "module", dependencies: version ? { "new-package": version } : {}, devDependencies: { "@types/node": "^22.10.7" } });
    await assert.rejects(generatePluginHostApi(f.root, { moduleIds: ["contract"] }), /publishable package version: new-package/);
    assert.deepEqual(await f.snapshot(), before);
  }
});

test("a failed candidate exchange restores the previous complete package and maintained files", async t => {
  const f = await completeFixture(t), before = await f.snapshot();
  await f.write("src/contract.ts", "export const changed = 2;\n");
  await f.write("dist/host-api-types/contract.d.ts", "export declare const changed = 2;\n");
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === f.output && path.basename(from).startsWith(".host-api-candidate-") && !from.endsWith("-previous")) {
      throw Object.assign(new Error("Controlled candidate exchange failure"), { code: "EACCES" });
    }
    return rename(from, to);
  };
  try { await assert.rejects(generatePluginHostApi(f.root, { moduleIds: ["contract"] }), /Controlled candidate exchange failure/); }
  finally { fs.rename = rename; }
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await fs.readdir(path.dirname(f.output)), ["host-api"]);
});

test("signature-only generation is explicit and preserves maintained source and existing types", async t => {
  const f = await completeFixture(t), before = await f.snapshot();
  await f.write("src/new-contract.ts", "export const newValue = 2;\n");
  const result = await generatePluginHostApi(f.root, { moduleIds: ["new-contract"], signaturesOnly: true });
  assert.deepEqual(result, { modules: 1, declarations: 0, signaturesOnly: true });
  const after = await f.snapshot();
  for (const file of ["README.md", "requested-modules.json", "types/src/contract.d.ts"]) assert.equal(after[file], before[file]);
  assert.deepEqual(JSON.parse(Buffer.from(after["modules.json"], "base64").toString()).modules, { "new-contract": { exports: ["newValue"] } });
});

async function addSelfReference(f) {
  await f.write("tsconfig.json", { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src",
    baseUrl: ".", paths: { "@rabiroute/host-api/*": ["src/*.ts"] }, types: [] } });
  await f.write("src/hidden.ts", "export type Hidden = { id: string };\n");
  await f.write("src/contract.ts", 'import type { Hidden } from "@rabiroute/host-api/hidden"; export function accept(): Hidden { return { id: "fixture" }; }\n');
  await f.write("dist/host-api-types/contract.d.ts", 'import type { Hidden } from "@rabiroute/host-api/hidden"; export declare function accept(): Hidden;\n');
  await f.write("dist/host-api-types/hidden.d.ts", "export type Hidden = { id: string };\n");
  const config = ts.readConfigFile(path.join(f.root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, f.root);
  const source = ts.createProgram([path.join(f.root, "src/contract.ts")], { ...parsed.options, noEmit: true });
  assert.deepEqual(source.getSemanticDiagnostics(), [], "The source workspace is valid; publication must independently enforce its public boundary.");
}

test("an unpublished self module fails before replacing the previous complete host API", async t => {
  const f = await completeFixture(t), before = await f.snapshot();
  await addSelfReference(f);
  await assert.rejects(generatePluginHostApi(f.root, { moduleIds: ["contract"] }), /references unpublished host API module: @rabiroute\/host-api\/hidden/);
  assert.deepEqual(await f.snapshot(), before);
  const published = JSON.parse(await fs.readFile(path.join(f.output, "package.json"), "utf8"));
  assert.equal(published.exports["./hidden"], undefined, "The generator must not expand the requested public boundary.");
});

test("requested self modules publish their complete declarations for an independent NodeNext consumer", async t => {
  const f = await completeFixture(t);
  await addSelfReference(f);
  assert.deepEqual(await generatePluginHostApi(f.root, { moduleIds: ["contract", "hidden"] }), { modules: 2, declarations: 2, signaturesOnly: false });
  const consumer = path.join(f.root, "independent-consumer");
  await f.write("independent-consumer/package.json", { name: "independent-type-consumer", type: "module" });
  await f.write("independent-consumer/index.ts", 'import { accept } from "@rabiroute/host-api/contract"; import type { Hidden } from "@rabiroute/host-api/hidden"; const value: Hidden = accept(); value.id.toUpperCase();\n');
  const installedApi = path.join(consumer, "node_modules/@rabiroute/host-api");
  await fs.cp(f.output, installedApi, { recursive: true });
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noEmit: true, types: [] };
  const program = ts.createProgram([path.join(consumer, "index.ts")], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")), []);
  const resolved = ts.resolveModuleName("@rabiroute/host-api/hidden", path.join(installedApi, "types/src/contract.d.ts"), options, ts.sys).resolvedModule;
  assert.ok(resolved);
  assert.equal(path.resolve(resolved.resolvedFileName), path.join(installedApi, "types/src/hidden.d.ts"));
  // TypeScript canonicalizes Windows node_modules paths, including inherited 8.3 TEMP aliases.
  const canonicalConsumer = ts.sys.realpath(consumer);
  const projectFiles = program.getSourceFiles().filter(file => !program.isSourceFileDefaultLibrary(file))
    .map(file => path.relative(canonicalConsumer, ts.sys.realpath(file.fileName)).replaceAll("\\", "/")).sort();
  assert.deepEqual(projectFiles, ["index.ts", "node_modules/@rabiroute/host-api/types/src/contract.d.ts", "node_modules/@rabiroute/host-api/types/src/hidden.d.ts"],
    "The independent consumer reads only its entry and the two installed public declarations.");
});
