import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileAutomaticCode } from "./lib/automatic-code-compiler.mjs";
import { automaticCodeRuntime as runtime } from "../src/plugin-kernel/automaticCodeRuntime.ts";
import { AutomaticCodeRuntime } from "../src/plugin-kernel/automaticCodeRuntime.ts";

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
