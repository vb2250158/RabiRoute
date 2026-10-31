import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { hasReleasablePluginScope, kernelImportViolations, publicationPackageViolations } from "./lib/plugin-platform-contract.mjs";

const file = "src/plugin-kernel/example.ts";
const leaf = "@rabiroute/plugin-sdk/publication";
const plugin = body => `export const activate = definePlugin({ activate(context) { ${body} } }).activate;`;
const cleanup = `{ publish() {}, rollback() {}, retire() { return owner.stopAndJoin(); } }`;
const manifest = { exports: { "./publication": { types: "./publication.d.ts", import: "./publication.mjs", default: "./publication.mjs" } },
  files: ["publication.mjs", "publication.d.ts"] };

test("kernel permits only named publication lifecycle values and types from its formal leaf", () => {
  const source = `
    import { randomUUID } from "node:crypto";
    import { EffectScope } from "./effectScope.js";
    import { PublicationScope as Scope } from "${leaf}";
    import type { PluginPublicationRegistrar } from "${leaf}";
    import { type PluginPublication } from "${leaf}";
    export type { PluginPublication, PluginPublicationContext, PluginPublicationRegistrar } from "${leaf}";
    type Contract = import("${leaf}").PluginPublication;
  `;
  assert.deepEqual(kernelImportViolations(file, source), []);
});

test("kernel rejects the SDK root, other leaves, business modules and non-named leaf bindings", () => {
  const rejected = [
    `import { PublicationScope } from "@rabiroute/plugin-sdk";`,
    `import type { PluginPublication } from "@rabiroute/plugin-sdk";`,
    `import { ServiceResolver } from "${leaf}";`,
    `import type { ApiOperationContract } from "${leaf}";`,
    `import { PluginPublication } from "${leaf}";`,
    `import Scope from "${leaf}";`, `import * as Scope from "${leaf}";`, `import "${leaf}";`,
    `export * from "${leaf}";`, `export { PublicationScope } from "${leaf}";`,
    `const scope = import("${leaf}");`, `const scope = require("${leaf}");`,
    `import Scope = require("${leaf}");`, `type All = typeof import("${leaf}");`,
    `import type { ApiOperationContract } from "@rabiroute/plugin-sdk/api-operation-contract";`,
    `import { value } from "../manager/service.js";`, `import { value } from "./../manager/service.js";`,
    String.raw`import { value } from "./..\\manager/service.js";`
  ];
  for (const source of rejected) assert.equal(kernelImportViolations(file, source).length, 1, source);
});

test("kernel import checks ignore comments and string examples instead of parsing text as imports", () => {
  assert.deepEqual(kernelImportViolations(file, `// import value from "business-module";
    const example = 'import value from "business-module"';`), []);
});

test("publication export points to the one dependency-free implementation with stable declarations", async () => {
  const packageRoot = new URL("../plugins/contracts/plugin-sdk/", import.meta.url);
  const [metadata, source, declarations, root, direct] = await Promise.all([
    fs.readFile(new URL("package.json", packageRoot), "utf8").then(JSON.parse),
    fs.readFile(new URL("publication.mjs", packageRoot), "utf8"),
    fs.readFile(new URL("publication.d.ts", packageRoot), "utf8"),
    import("@rabiroute/plugin-sdk"), import("@rabiroute/plugin-sdk/publication")
  ]);
  assert.deepEqual(publicationPackageViolations(metadata, source, declarations), []);
  assert.equal(root.PublicationScope, direct.PublicationScope);
});

test("publication leaf rejects runtime and declaration dependencies or an indirect package export", () => {
  for (const source of [`import { value } from "./business.mjs";`, `export * from "./business.mjs";`,
    `const dependency = require("business");`, `const dependency = import("./business.mjs");`]) {
    assert.ok(publicationPackageViolations(manifest, source).length > 0, source);
  }
  for (const declarations of [`import type { Owner } from "./business.js";`,
    `type Owner = import("./business.js").Owner;`, `type Owner = ManagerBusinessOwner;`, `type Owner = typeof process;`]) {
    assert.ok(publicationPackageViolations(manifest, "", declarations).length > 0, declarations);
  }
  assert.ok(publicationPackageViolations({ ...manifest, exports: { "./publication": { import: "./index.mjs" } } }, "").length > 0);
  assert.deepEqual(publicationPackageViolations(manifest, `// import value from "business";\nexport class PublicationScope {}`,
    `export type PluginPublication = Readonly<{ signal: AbortSignal; join(): Promise<void> }>;`), []);
});

test("publication-only activation with a real retire callback owns a releasable scope", () => {
  assert.equal(hasReleasablePluginScope(plugin(`context.publication.add(${cleanup});`)), true);
  assert.equal(hasReleasablePluginScope(plugin(`context.publication.add({ publish() {}, rollback() {},
    retire() { return handle?.dispose(); } });`)), true);
});

test("empty, fake, startup-only and uninvoked cleanup declarations do not satisfy publication ownership", () => {
  const invalid = [
    `context.publication.add({});`,
    `context.publication.add({ publish() {}, rollback() {} });`,
    `context.publication.add({ publish() {}, rollback() {}, retire() {} });`,
    `context.publication.add({ publish() {}, rollback() {}, retire() { return Promise.resolve(); } });`,
    `context.publication.add({ publish() {}, rollback() {}, retire() { console.log("dispose"); } });`,
    `context.publication.add({ publish() {}, rollback() {}, retire() { return () => owner.stop(); } });`,
    `context.publication.add({ publish() {}, rollback() {}, *retire() { yield owner.stop(); } });`,
    `context.publication.add({ publish() {}, rollback() {}, afterPublish() { return owner.start(); } });`,
    `// context.publication.add(${cleanup});`, `const example = 'context.publication.add(${cleanup})';`,
    `function unused() { context.publication.add(${cleanup}); }`
  ];
  for (const body of invalid) assert.equal(hasReleasablePluginScope(plugin(body)), false, body);
});

test("lexical descriptor, shorthand retire and Promise cleanup references resolve without execution", () => {
  assert.equal(hasReleasablePluginScope(plugin(`
    const retire = () => Promise.resolve().then(() => owner.stopAndJoin());
    const descriptor = Object.freeze({ publish() {}, rollback() {}, retire });
    const alias = descriptor;
    context.publication.add(alias);
  `)), true);
  assert.equal(hasReleasablePluginScope(`const retire = () => owner.stop();
    ${plugin(`const retire = () => {}; context.publication.add({ publish() {}, rollback() {}, retire });`)}`), false);
});

test("package-local imported lifecycle references resolve to actual retirement instead of trusting names", () => {
  const source = `import { createLifecycle } from "./lifecycle.mjs";
    ${plugin(`const lifecycle = createLifecycle(owner); context.publication.add(lifecycle.publication);`)}`;
  const modules = new Map([["lifecycle.mjs", `throw new Error("This module must only be parsed, never executed");
    export function createLifecycle(owner) { const close = () => owner.stopAndJoin();
      return Object.freeze({ publication: Object.freeze({ publish() {}, rollback() {}, retire: close }) }); }`]]);
  assert.equal(hasReleasablePluginScope(source, { modules }), true);
  modules.set("lifecycle.mjs", `export function createLifecycle() { return { publication: { publish() {}, rollback() {}, retire() {} } }; }`);
  assert.equal(hasReleasablePluginScope(source, { modules }), false);
  assert.equal(hasReleasablePluginScope(source), false);
});

test("effect and adoption gates require a real cleanup function rather than a matching text fragment", () => {
  assert.equal(hasReleasablePluginScope(plugin(`context.effects.add(() => () => owner.stop());`)), true);
  assert.equal(hasReleasablePluginScope(plugin(`const close = () => owner.dispose(); context.effects.adopt(close);`)), true);
  assert.equal(hasReleasablePluginScope(plugin(`context.effects.add(() => () => {});`)), false);
  assert.equal(hasReleasablePluginScope(plugin(`const example = "context.effects.add(";`)), false);
});

test("same-name local context shadows do not count as the actual activation parameter", () => {
  for (const body of [
    `{ const context = { publication: { add() {} } }; context.publication.add(${cleanup}); }`,
    `{ const { context } = fake; context.publication.add(${cleanup}); }`,
    `for (const context of fake) { context.publication.add(${cleanup}); }`,
    `try { work(); } catch (context) { context.publication.add(${cleanup}); }`,
    `{ class context {} context.publication.add(${cleanup}); }`
  ]) assert.equal(hasReleasablePluginScope(plugin(body)), false, body);
  assert.equal(hasReleasablePluginScope(plugin(`
    { const context = fake; context.publication.add({}); }
    context.publication.add(${cleanup});
  `)), true);
  assert.equal(hasReleasablePluginScope(plugin(`
    try { work(); } catch (context) { inspect(context); }
    context.publication.add(${cleanup});
  `)), true);
});

test("publication declaration heritage rejects business owners and retains pure local interfaces", () => {
  for (const declarations of [
    `export interface PluginPublication extends ManagerBusinessOwner {}`,
    `export class PublicationScope extends ManagerBusinessOwner {}`,
    `export class PublicationScope implements ManagerBusinessOwner {}`,
    `export interface PluginPublication extends Manager.BusinessOwner {}`
  ]) assert.ok(publicationPackageViolations(manifest, "", declarations).length > 0, declarations);
  assert.deepEqual(publicationPackageViolations(manifest, "", `
    interface PureLifecycle { signal: AbortSignal; }
    export interface PluginPublication extends PureLifecycle { retire(): Promise<void>; }
  `), []);
});
