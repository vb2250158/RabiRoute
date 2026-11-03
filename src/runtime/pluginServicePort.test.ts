import assert from "node:assert/strict";
import test from "node:test";
import { createPluginServicePort } from "./pluginServicePort.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

test("a retained method resolves the current native provider and preserves its receiver", async () => {
  let current = { value: "first", read() { return this.value; } };
  const port = createPluginServicePort(() => current);
  const read = port.read;
  current = { value: "second", read() { return this.value; } };
  assert.equal(read(), "second"); assert.equal(port.value, "second");
});

test("an in-flight operation keeps its admitted owner while later calls fail after provider removal", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const owner = { value: "original", async read() { await held; return this.value; } };
  let active = true;
  const port = createPluginServicePort(() => { if (!active) throw new Error("Service is unavailable"); return owner; });
  const pending = port.read(); active = false;
  assert.throws(() => port.read(), /unavailable/);
  release(); assert.equal(await pending, "original");
});

test("the actual instrumented port can be constructed before an optional provider is published", async t => {
  // Run the production automatic compiler and its real retainHotPatchResult path.
  // @ts-ignore Native build helper.
  const { compileAutomaticCode } = await import("../../scripts/lib/automatic-code-compiler.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "instrumented-service-port-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "service-port.mjs");
  const source = ts.transpileModule(await fs.readFile(new URL("./pluginServicePort.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const generated = compileAutomaticCode(source, file, new URL("../plugin-kernel/automaticCodeRuntime.ts", import.meta.url).href);
  await fs.writeFile(file, generated.output);
  const compiled = await import(pathToFileURL(file).href) as typeof import("./pluginServicePort.js");
  let current: { read(): string } | undefined, resolutions = 0;
  const port = compiled.createPluginServicePort(() => { resolutions++; if (!current) throw new Error("optional provider unavailable"); return current; });
  assert.equal(resolutions, 0);
  assert.equal(await Promise.resolve(port), port);
  assert.equal(Object.prototype.toString.call(port), "[object PluginServicePort]");
  assert.equal(Reflect.get(port, Symbol.asyncIterator), undefined);
  assert.equal(resolutions, 0, "language and instrumentation inspection cannot start optional business");
  assert.throws(() => port.read(), /provider unavailable/);
  current = { read: () => "ready" }; assert.equal(port.read(), "ready");
  const read = port.read;
  current = undefined; assert.throws(read, /provider unavailable/);
});
