import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileAutomaticCode } from "./lib/automatic-code-compiler.mjs";
import { automaticCodeRuntime as runtime } from "../src/plugin-kernel/automaticCodeRuntime.ts";
import { AutomaticCodeRuntime } from "../src/plugin-kernel/automaticCodeRuntime.ts";

test("nested synchronous helpers reuse one lease and keep the caller revision across a patch", () => {
  const isolated = new AutomaticCodeRuntime();
  let bridge;
  const baseline = compileAutomaticCode('export function inner(){return 1;} export function outer(){return invokeInner();}', 'nested-sync').definition;
  const invokeInner = () => {
    assert.equal(isolated.snapshot().retained.reduce((sum, item) => sum + item.leases, 0), 1);
    const commit = isolated.prepareBatch([compileAutomaticCode('export function inner(){return 2;} export function outer(){return invokeInner();}', 'nested-sync').definition], 0);
    commit();
    for (let i = 0; i < 1000; i++) assert.equal(bridge.invoke('inner', undefined, []), 1);
    return 1;
  };
  bridge = isolated.register(baseline, source => eval(source));
  assert.equal(bridge.invoke('outer', undefined, []), 1);
  assert.equal(bridge.invoke('inner', undefined, []), 2);
  assert.ok(isolated.snapshot().retained.every(item => item.leases === 0));
});

test("nested async work remains pinned after its synchronous caller returns", async () => {
  const isolated = new AutomaticCodeRuntime();
  let bridge, child;
  const invokeInner = () => bridge.invoke('inner', undefined, []);
  const startChild = wait => { child = bridge.invoke('asyncChild', undefined, [wait]); };
  const source = 'export function inner(){return 1;} export async function asyncChild(wait){await wait;return invokeInner();} export function start(wait){startChild(wait);}';
  bridge = isolated.register(compileAutomaticCode(source, 'nested-async').definition, source => eval(source));
  let resume;
  bridge.invoke('start', undefined, [new Promise(resolve => { resume = resolve; })]);
  isolated.prepareBatch([compileAutomaticCode(source.replace('return 1;', 'return 2;'), 'nested-async').definition], 0)();
  resume();
  assert.equal(await child, 1);
  assert.equal(bridge.invoke('inner', undefined, []), 2);
  assert.ok(isolated.snapshot().retained.every(item => item.leases === 0));
});

test("nested generators keep their revision until consumed or explicitly closed", () => {
  const isolated = new AutomaticCodeRuntime();
  let bridge, saved;
  const iterator = function* () { yield bridge.invoke('inner', undefined, []); yield bridge.invoke('inner', undefined, []); };
  const invokeCreate = () => bridge.invoke('create', undefined, []);
  const save = value => { saved = value; };
  const source = 'export function inner(){return 1;} export function create(){return iterator();} export function start(){save(invokeCreate());}';
  bridge = isolated.register(compileAutomaticCode(source, 'nested-generator').definition, source => eval(source));
  bridge.invoke('start', undefined, []);
  isolated.prepareBatch([compileAutomaticCode(source.replace('return 1;', 'return 2;'), 'nested-generator').definition], 0)();
  assert.deepEqual(saved.next(), { done: false, value: 1 });
  assert.ok(isolated.snapshot().retained.some(item => item.leases > 0));
  saved.return();
  assert.ok(isolated.snapshot().retained.every(item => item.leases === 0));
  assert.equal(bridge.invoke('inner', undefined, []), 2);
});

async function fixture(source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-automatic-code-"));
  const file = path.join(root, "module.mjs");
  const moduleId = root.replaceAll("\\", "/");
  const compiled = compileAutomaticCode(source, moduleId, new URL("../src/plugin-kernel/automaticCodeRuntime.ts", import.meta.url).href);
  await fs.writeFile(file, compiled.output);
  const module = await import(pathToFileURL(file).href);
  return { module, definition: compiled.definition, patch(next) {
    const candidate = compileAutomaticCode(next, moduleId).definition;
    return runtime.prepareBatch([candidate], runtime.snapshot().revision)();
  } };
}

test("automatic module keeps state, callback identity, imports and single default evaluation", async () => {
  const source = 'import { basename } from "node:path"; let calls=0; export function count(value=++calls){return basename("/root/name")+value;} export function read(){return calls;}';
  const entry = await fixture(source);
  const retained = entry.module.count;
  assert.equal(retained(), "name1");
  assert.equal(entry.module.read(), 1);
  entry.patch(source.replace('+value;', '+value+"!";'));
  assert.equal(entry.module.count, retained);
  assert.equal(retained(), "name2!");
  assert.equal(entry.module.read(), 2);
});

test("relative ESM imports retain constants, classes, aliases and cross-module revisions", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-automatic-imports-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeImport = new URL("../src/plugin-kernel/automaticCodeRuntime.ts", import.meta.url).href;
  const helperId = path.join(root, "helper.mjs").replaceAll("\\", "/");
  const moduleId = path.join(root, "module.mjs").replaceAll("\\", "/");
  const helperSource = 'export const base=3;export class Box{value=5;}export function calculate(value){return value+1;}';
  const source = 'import {calculate as aliased,base,Box} from "./helper.mjs";export function read(){return {result:aliased(base),box:new Box().value,base};}export function shadow(aliased){return aliased;}';
  const helper = compileAutomaticCode(helperSource, helperId, runtimeImport);
  const compiled = compileAutomaticCode(source, moduleId, runtimeImport);
  await fs.writeFile(helperId, helper.output);
  await fs.writeFile(moduleId, compiled.output);
  const entry = await import(pathToFileURL(moduleId).href);
  const retained = entry.read;
  assert.deepEqual(retained(), { result: 4, box: 5, base: 3 });
  assert.equal(entry.shadow(7), 7);
  const boundary = runtime.acquireBoundary();
  try {
    runtime.prepareBatch([
      compileAutomaticCode(helperSource.replace("value+1", "value+2"), helperId).definition,
      compileAutomaticCode(source.replace("aliased(base)", "aliased(base)+10"), moduleId).definition
    ], runtime.snapshot().revision)();
    assert.deepEqual(boundary.run(() => retained()), { result: 4, box: 5, base: 3 });
    assert.deepEqual(retained(), { result: 15, box: 5, base: 3 });
    assert.equal(entry.read, retained);
    assert.equal(entry.shadow(8), 8);
  } finally { boundary.release(); }
  assert.ok(runtime.snapshot().retained.every(revision => revision.leases === 0));
});

test("ordinary class methods preserve existing instances and bound methods", async () => {
  const source = 'export class Counter { value=3; add(step){this.value+=step;return this.value;} }';
  const entry = await fixture(source);
  const instance = new entry.module.Counter();
  const callback = instance.add.bind(instance);
  assert.equal(callback(1), 4);
  entry.patch(source.replace('+=step', '+=step*2'));
  assert.equal(callback(1), 6);
  assert.ok(instance instanceof entry.module.Counter);
});

test("in-flight async calls keep their original internal implementations", async () => {
  const source = 'export function inner(){return 1;} export async function outer(wait){await wait;return inner();}';
  const entry = await fixture(source);
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const old = entry.module.outer(waiting);
  entry.patch(source.replace('return 1', 'return 2'));
  finish();
  assert.equal(await old, 1);
  assert.equal(await entry.module.outer(Promise.resolve()), 2);
});

test("initializers and import changes reject atomically", async () => {
  const source = 'let value=1;export function read(){return value;}';
  const entry = await fixture(source);
  assert.equal(entry.module.read(), 1);
  assert.throws(() => entry.patch(source.replace('value=1', 'value=2')), /controlled switch/);
  assert.equal(entry.module.read(), 1);
});

test("unsupported method changes are visible and cannot become partial patches", async () => {
  const source = 'export class Counter { #value=1;read(){return this.#value;} } export function ping(){return 1;}';
  const entry = await fixture(source);
  assert.match(entry.definition.unsupported[0].reason, /private fields/);
  entry.module.ping();
  assert.throws(() => entry.patch(source.replace('this.#value;', 'this.#value+1;').replace('return 1;', 'return 2;')), /controlled switch/);
  assert.equal(entry.module.ping(), 1);
});

test("new ordinary modules register lazily without modifying a central catalog", async () => {
  const entry = await fixture('export function fresh(){return 7;}');
  assert.equal(entry.module.fresh(), 7);
  entry.patch('export function fresh(){return 8;}');
  assert.equal(entry.module.fresh(), 8);
  assert.ok(runtime.snapshot().retained.length <= 2);
});

test("a saved closure body cannot silently stay old after a patch", async () => {
  const source = 'export function create(value){return () => value+1;} export function ping(){return 1;}';
  const entry = await fixture(source);
  const retained = entry.module.create(4);
  assert.equal(retained(), 5);
  assert.throws(() => entry.patch(source.replace('value+1', 'value+2').replace('return 1;', 'return 2;')), /controlled switch/);
  assert.equal(retained(), 5);
  assert.equal(entry.module.ping(), 1);
});

test("comments do not require a controlled switch", async () => {
  const source = '/* baseline */ export function read(){return 1;}';
  const entry = await fixture(source);
  entry.module.read();
  entry.patch(source.replace('baseline', 'documentation').replace('return 1', 'return 2'));
  assert.equal(entry.module.read(), 2);
});

test("implementation identifiers cannot alter the compiler record prototype", async () => {
  const entry = await fixture('export function __proto__(){return 7;}');
  assert.equal(entry.module.__proto__(), 7);
  entry.patch('export function __proto__(){return 8;}');
  assert.equal(entry.module.__proto__(), 8);
});

test("candidate preparation snapshots inputs and rejects duplicate module identities", () => {
  const isolated = new AutomaticCodeRuntime();
  const baseline = compileAutomaticCode('export function read(){return 1;}', 'fixture').definition;
  const registered = isolated.register(baseline, source => eval(source));
  const candidate = compileAutomaticCode('export function read(){return 2;}', 'fixture').definition;
  assert.throws(() => isolated.prepareBatch([candidate, candidate], 0), /Duplicate/);
  const commit = isolated.prepareBatch([candidate], 0);
  candidate.implementations.read = 'function(){return 99;}';
  commit();
  assert.equal(registered.invoke('read', undefined, []), 2);
});

test("a thrown or rejected call releases old revisions", async () => {
  const source = 'export function fail(){throw new Error("expected");} export async function reject(){throw new Error("expected");}';
  const entry = await fixture(source);
  assert.throws(() => entry.module.fail(), /expected/);
  await assert.rejects(entry.module.reject(), /expected/);
  assert.ok(runtime.snapshot().retained.every(revision => revision.leases === 0));
});

test("callbacks scheduled by a returned function keep an active request boundary", async () => {
  const source = 'export function read(){return 1;} export function schedule(wait, done){wait.then(() => done(read()));}';
  const entry = await fixture(source);
  const boundary = runtime.acquireBoundary();
  let resume;
  const wait = new Promise(resolve => { resume = resolve; });
  const received = new Promise(resolve => boundary.run(() => entry.module.schedule(wait, resolve)));
  entry.patch(source.replace('return 1;', 'return 2;'));
  resume();
  assert.equal(await received, 1);
  boundary.release();
  assert.equal(entry.module.read(), 2);
});

test("tracked work preserves a closed response boundary until business completion", async () => {
  const source = 'export function read(){return 1;} export function schedule(wait, done){wait.then(() => done(read()));}';
  const entry = await fixture(source);
  const boundary = runtime.acquireBoundary();
  let resume;
  const wait = new Promise(resolve => { resume = resolve; });
  const received = new Promise(resolve => boundary.run(() => entry.module.schedule(wait, resolve)));
  boundary.run(() => runtime.trackOperation(received));
  boundary.release();
  entry.patch(source.replace('return 1;', 'return 2;'));
  resume();
  assert.equal(await received, 1);
  await Promise.resolve();
  assert.equal(entry.module.read(), 2);
  assert.ok(runtime.snapshot().retained.every(revision => revision.leases === 0));
});
