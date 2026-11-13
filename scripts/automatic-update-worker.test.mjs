import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { instrumentAutomaticCode } from "./instrument-automatic-code.mjs";
import { prepareAutomaticCodeUpdate } from "./automatic-update-worker.mjs";

async function baseline(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automatic-worker-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ["src", "dist", "source-patches"]) await fs.mkdir(path.join(root, directory));
  await fs.writeFile(path.join(root, "source-patches/modules.json"), '{"modules":[]}');
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({type:"module",name:"automatic-fixture",version:"1.0.0",description:"Original description"}));
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({name:"automatic-fixture",version:"1.0.0",lockfileVersion:3,packages:{"":{name:"automatic-fixture",version:"1.0.0"}}}));
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, types: [], rootDir: "src", outDir: "dist"
  }, include: ["src/**/*.ts"] }));
  const source = 'export function read(value: number) { return value+1; }';
  await fs.writeFile(path.join(root, "src/module.ts"), source);
  await fs.writeFile(path.join(root, "dist/module.js"), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText);
  await instrumentAutomaticCode(root);
  return { sourceRoot: root, packageRoot: root };
}

test("worker emits compatible source changes from a frozen compiler inventory", async context => {
  const roots = await baseline(context);
  const original = await prepareAutomaticCodeUpdate(roots);
  assert.equal(original.state, "prepared");
  await fs.writeFile(path.join(roots.sourceRoot, "src/module.ts"), 'export function read(value: number) { return value+2; }');
  const candidate = await prepareAutomaticCodeUpdate(roots);
  assert.equal(candidate.state, "prepared", JSON.stringify(candidate));
  assert.deepEqual(candidate.changedFiles, ["src/module.ts"]);
  assert.notEqual(candidate.digest, original.digest);
  assert.match(candidate.definitions[0].implementations.read, /value \+ 2/);
});

test("compiler metadata uses the frozen catalog even when source and package share a directory", async context => {
  const roots = await baseline(context);
  await fs.writeFile(path.join(roots.sourceRoot, "package.json"), '{"type":"module","version":"2.0.0"}');
  const candidate = await prepareAutomaticCodeUpdate(roots);
  assert.equal(candidate.state, "requires_switch");
  assert.equal(candidate.reasons[0].file, "package.json");
});

test("new and removed executable files cannot be silently ignored", async context => {
  const roots = await baseline(context);
  await fs.writeFile(path.join(roots.sourceRoot, "src/new.ts"), "export const added=1;");
  const added = await prepareAutomaticCodeUpdate(roots);
  assert.equal(added.state, "requires_switch");
  assert.equal(added.reasons[0].file, "src/new.ts");
  await fs.unlink(path.join(roots.sourceRoot, "src/new.ts"));
  await fs.unlink(path.join(roots.sourceRoot, "src/module.ts"));
  const removed = await prepareAutomaticCodeUpdate(roots);
  assert.equal(removed.state, "requires_switch");
  assert.match(removed.reasons[0].reason, /removed/);
});

test("compiler errors cannot produce a partial candidate", async context => {
  const roots = await baseline(context);
  await fs.writeFile(path.join(roots.sourceRoot, "src/module.ts"), 'export function read(value: number) { return missing(value); }');
  await assert.rejects(prepareAutomaticCodeUpdate(roots), /missing/);
});

async function detachedSource(context) {
  const installed=await baseline(context);
  const sourceRoot=await fs.mkdtemp(path.join(os.tmpdir(),"automatic-source-"));
  context.after(()=>fs.rm(sourceRoot,{recursive:true,force:true}));
  await fs.cp(installed.packageRoot,sourceRoot,{recursive:true});
  return {packageRoot:installed.packageRoot,sourceRoot};
}
test("pinned package metadata and lock root versions reach actual compatible runtime preparation",async context=>{
  const roots=await detachedSource(context);
  const original=await prepareAutomaticCodeUpdate(roots);
  const metadata=JSON.parse(await fs.readFile(path.join(roots.sourceRoot,"package.json"),"utf8"));
  metadata.version="1.0.1";metadata.description="Updated release description";
  await fs.writeFile(path.join(roots.sourceRoot,"package.json"),JSON.stringify(metadata,null,2)+"\n");
  const lock=JSON.parse(await fs.readFile(path.join(roots.sourceRoot,"package-lock.json"),"utf8"));
  lock.version="1.0.1";lock.packages[""].version="1.0.1";
  await fs.writeFile(path.join(roots.sourceRoot,"package-lock.json"),JSON.stringify(lock,null,4)+"\n");
  await fs.writeFile(path.join(roots.sourceRoot,"src/module.ts"),"export function read(value: number) { return value+2; }");
  const candidate=await prepareAutomaticCodeUpdate(roots);
  assert.equal(candidate.state,"prepared",JSON.stringify(candidate));
  const {AutomaticCodeRuntime}=await import("../src/plugin-kernel/automaticCodeRuntime.ts");
  const runtime=new AutomaticCodeRuntime();
  const bridge=runtime.register(original.definitions[0],body=>eval(body));
  assert.equal(bridge.invoke("read",undefined,[1]),2);
  runtime.prepareBatch(candidate.definitions,runtime.snapshot().revision)();
  assert.equal(bridge.invoke("read",undefined,[1]),3);
  assert.notEqual(candidate.inputDigest,original.inputDigest);
});
test("format-only JSON compiler configuration is equivalent with a readable pinned baseline",async context=>{
  const roots=await detachedSource(context);
  const original=await prepareAutomaticCodeUpdate(roots);
  const config=JSON.parse(await fs.readFile(path.join(roots.sourceRoot,"tsconfig.json"),"utf8"));
  await fs.writeFile(path.join(roots.sourceRoot,"tsconfig.json"),"// equivalent compiler configuration\n"+JSON.stringify(config,null,2)+"\n");
  const candidate=await prepareAutomaticCodeUpdate(roots);
  assert.equal(candidate.state,"prepared",JSON.stringify(candidate));
  assert.notEqual(candidate.inputDigest,original.inputDigest);
});
test("execution-significant package, lock and compiler edits retain their controlled switch",async context=>{
  const roots=await detachedSource(context);
  const packageFile=path.join(roots.sourceRoot,"package.json"),packageBytes=await fs.readFile(packageFile);
  const packageValue=JSON.parse(packageBytes);
  for(const change of [{scripts:{build:"node different.mjs"}},{type:"commonjs"},{imports:{"#new":"./dist/new.js"}},{exports:{".":"./dist/new.js"}},{dependencies:{fixture:"2.0.0"}},{engines:{node:">=24"}}]){
    await fs.writeFile(packageFile,JSON.stringify({...packageValue,...change}));
    const candidate=await prepareAutomaticCodeUpdate(roots);
    assert.equal(candidate.state,"requires_switch");assert.ok(candidate.reasons.some(row=>row.file==="package.json"));
  }
  await fs.writeFile(packageFile,packageBytes);
  const lockFile=path.join(roots.sourceRoot,"package-lock.json"),lock=JSON.parse(await fs.readFile(lockFile,"utf8"));
  lock.packages["node_modules/fixture"]={version:"2.0.0",integrity:"sha512-fixture"};
  await fs.writeFile(lockFile,JSON.stringify(lock));
  const locked=await prepareAutomaticCodeUpdate(roots);assert.equal(locked.state,"requires_switch");assert.ok(locked.reasons.some(row=>row.file==="package-lock.json"));
  await fs.copyFile(path.join(roots.packageRoot,"package-lock.json"),lockFile);
  const configFile=path.join(roots.sourceRoot,"tsconfig.json"),config=JSON.parse(await fs.readFile(configFile,"utf8"));
  config.compilerOptions.target="ES2020";await fs.writeFile(configFile,JSON.stringify(config));
  const compiled=await prepareAutomaticCodeUpdate(roots);assert.equal(compiled.state,"requires_switch");assert.ok(compiled.reasons.some(row=>row.file==="tsconfig.json"));
});
test("metadata equivalence requires the original installed bytes to match the frozen catalog",async context=>{
  const roots=await detachedSource(context);
  const filename=path.join(roots.sourceRoot,"package.json"),value=JSON.parse(await fs.readFile(filename,"utf8"));
  value.version="2.0.0";await fs.writeFile(filename,JSON.stringify(value));
  await fs.writeFile(path.join(roots.packageRoot,"package.json"),JSON.stringify({...value,version:"altered-installed-baseline"}));
  const altered=await prepareAutomaticCodeUpdate(roots);assert.equal(altered.state,"requires_switch");assert.match(altered.reasons.find(row=>row.file==="package.json").reason,/baseline|frozen/i);
});

test("a missing pinned compiler baseline reports unavailable evidence without substituting the source",async context=>{
  const roots=await detachedSource(context);
  const filename=path.join(roots.sourceRoot,"tsconfig.json"),config=JSON.parse(await fs.readFile(filename,"utf8"));
  await fs.writeFile(filename,JSON.stringify(config,null,2)+"\n");
  await fs.unlink(path.join(roots.packageRoot,"tsconfig.json"));
  const candidate=await prepareAutomaticCodeUpdate(roots);
  assert.equal(candidate.state,"requires_switch");
  assert.match(candidate.reasons.find(row=>row.file==="tsconfig.json").reason,/baseline is unavailable/);
});
test("invalid JSON and unsupported lock representation cannot establish dependency equivalence",async context=>{
  const roots=await detachedSource(context);
  for(const [filename,contents] of [
    ["package.json","{invalid"],
    ["package-lock.json",JSON.stringify({lockfileVersion:2,version:"2.0.0",packages:{"":{version:"2.0.0"}}})],
    ["tsconfig.json","{compilerOptions: invalid}"]
  ]){
    await fs.writeFile(path.join(roots.sourceRoot,filename),contents);
    const candidate=await prepareAutomaticCodeUpdate(roots);
    assert.equal(candidate.state,"requires_switch");assert.ok(candidate.reasons.some(row=>row.file===filename));
    await fs.copyFile(path.join(roots.packageRoot,filename),path.join(roots.sourceRoot,filename));
  }
});
test("new type-erased files preserve actual runtime behavior and frozen raw input identity", async context => {
  const roots = await baseline(context);
  const original = await prepareAutomaticCodeUpdate(roots);
  const { AutomaticCodeRuntime } = await import("../src/plugin-kernel/automaticCodeRuntime.ts");
  const runtime = new AutomaticCodeRuntime();
  const bridge = runtime.register(original.definitions[0], body => eval(body));
  const before = runtime.snapshot();
  for (const [name, source] of [
    ["interface-only.ts", "export interface Packet { id: string; }\n"],
    ["type-only.ts", "export type PacketId = string;\nexport type PacketMap = Record<string, PacketId>;\n"]
  ]) {
    const filename = path.join(roots.sourceRoot, "src", name);
    await fs.writeFile(filename, source);
    const candidate = await prepareAutomaticCodeUpdate(roots);
    assert.equal(candidate.state, "prepared", JSON.stringify(candidate));
    assert.equal(candidate.digest, original.digest);
    assert.notEqual(candidate.inputDigest, original.inputDigest);
    const commit = runtime.prepareBatch(candidate.definitions, before.revision);
    assert.equal(typeof commit, "function");
    assert.deepEqual(runtime.snapshot(), before, "preparation does not publish or register the erased module");
    assert.equal(bridge.invoke("read", undefined, [1]), 2);
    await fs.unlink(filename);
  }
});

test("new actual imports, side effects, functions, classes and enums retain the original execution-owner boundary", async context => {
  const roots = await baseline(context);
  for (const [name, source] of [
    ["import-runtime.ts", 'import "./module.js";\n'],
    ["side-effect.ts", "globalThis.console.log('fixture initializer');\nexport {};\n"],
    ["function-runtime.ts", "export function added() { return 1; }\n"],
    ["class-runtime.ts", "export class Added { value = 1; }\n"],
    ["enum-runtime.ts", "export enum Added { One, Two }\n"]
  ]) {
    const filename = path.join(roots.sourceRoot, "src", name);
    await fs.writeFile(filename, source);
    const candidate = await prepareAutomaticCodeUpdate(roots);
    assert.equal(candidate.state, "requires_switch", name);
    assert.ok(candidate.reasons.some(reason => reason.file === "src/" + name));
    await fs.unlink(filename);
  }
});
