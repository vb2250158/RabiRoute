import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createStartupPresentationProjector, startupPresentationPath } from "./startupPresentation.js";
import { parseStartupTheme } from "../shared/startupPresentation.js";
import { DeclarativePluginExecutor } from "../plugin-kernel/pluginExecutor.js";
import { parsePluginManifest } from "../plugin-kernel/manifest.js";
import type { PluginContext, PluginContribution, PluginIdentity } from "../plugin-kernel/types.js";
import type { PluginProfile } from "../plugin-kernel/profile.js";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-startup-theme-")), packages = path.join(root, "packages");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const colors = { background: "#ffffff", foreground: "#16202a", accent: "#00c7c7" };
  const definition = (themeId = "fixture:one", logo = "./assets/logo.ico") => ({ surface: "shared.themes", hosts: ["desktop", "web"], themeId,
    startup: { schemaVersion: 1, light: colors, dark: { background: "#16202a", foreground: "#ffffff", accent: "#00c7c7" }, motion: "breathe", logo } });
  const add = (id: string, themeId = "fixture:one", logo?: string) => {
    const sourceRoot = path.join(packages, id); fs.mkdirSync(path.join(sourceRoot, "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "rabi.plugin.json"), JSON.stringify({ schemaVersion: 2, id, version: "0.1.1", entries: { manager: { execution: "declarative", resource: "./assets/theme.json" }, desktop: { execution: "declarative", resource: "./assets/theme.json" } }, provides: [], requires: [] }));
    fs.writeFileSync(path.join(sourceRoot, "assets/theme.json"), JSON.stringify({ contributions: [{ kind: "theme", id: themeId, value: definition(themeId, logo) }] }));
    fs.writeFileSync(path.join(sourceRoot, "assets/logo.ico"), Buffer.from([0, 0, 1, 0, 0, 0]));
    return { id, package: id, version: "0.1.1", enabled: true, config: {}, grants: [], policy: {} } as unknown as PluginProfile["instances"][number];
  };
  const projector = createStartupPresentationProjector({ stateRoot: root, resolvePackage: async id => ({ sourceRoot: path.join(packages, id) }) });
  const read = () => JSON.parse(fs.readFileSync(startupPresentationPath(root), "utf8"));
  return { root, packages, colors, definition, add, projector, read };
}
test("selected installed declarative theme publishes exact static local logo without changing source", async t => {
  const f = fixture(t), instance = f.add("io.test.theme"), source = path.join(f.packages, instance.id, "assets/theme.json"), before = fs.readFileSync(source);
  assert.equal(parseStartupTheme(f.definition())?.motion, "breathe");
  const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(path.join(f.packages, instance.id, "rabi.plugin.json"), "utf8")));
  assert.deepEqual(manifest.entries.manager, manifest.entries.desktop);
  const identity: PluginIdentity = { applicationGenerationId: "fixture-app", managerInstanceId: "fixture-manager", activationId: "fixture-activation", instanceId: instance.id,
    pluginId: instance.package, version: instance.version, revision: "fixture-source", host: "manager" };
  const module = await new DeclarativePluginExecutor().prepare({ instanceId: instance.id, revision: identity.revision, manifest, config: {},
    entry: { execution: "declarative", path: source } }, identity);
  const contributions: PluginContribution[] = [];
  await module.activate({ identity, config: {},
    services: { require() { throw new Error("unused"); }, optional() { return undefined; }, provide() {} },
    contributions: { register(value) { contributions.push(value); } },
    permissions: { has() { return false; }, require() { throw new Error("unused"); }, list() { return []; } },
    lifecycle: { signal: new AbortController().signal, fail() {} },
    publication: { add() { throw new Error("No executable publication in a static theme."); } }, effects: { add() {}, adopt() {} }
  } satisfies PluginContext);
  assert.equal(contributions.length, 1); assert.equal(parseStartupTheme(contributions[0]!.value)?.themeId, "fixture:one");
  const result = await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }));
  assert.equal(result.state, "selected"); const value = f.read();
  assert.equal(value.themeId, "fixture:one"); assert.deepEqual(value.light, f.colors); assert.equal(value.motion, "breathe");
  assert.ok(path.isAbsolute(value.logoPath)); assert.ok(value.logoPath.startsWith(path.join(f.root, "data/desktop/startup-theme-assets")));
  assert.deepEqual(fs.readFileSync(value.logoPath), fs.readFileSync(path.join(f.packages, instance.id, "assets/logo.ico")));
  assert.deepEqual(fs.readFileSync(source), before);
});
test("disabled or removed theme clears derived selection and retains private user data", async t => {
  const f = fixture(t), instance = f.add("io.test.theme"), settings = path.join(f.root, "private-user.json"); fs.writeFileSync(settings, "original user data");
  await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }));
  assert.equal((await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [{ ...instance, enabled: false }] } }))).state, "default");
  assert.equal(fs.existsSync(startupPresentationPath(f.root)), false);
  assert.equal((await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [] } }))).state, "default");
  assert.equal(fs.readFileSync(settings, "utf8"), "original user data");
});
test("one malformed optional declaration does not hide another selected theme", async t => {
  const f = fixture(t), broken = f.add("io.test.broken", "broken"), valid = f.add("io.test.valid");
  fs.writeFileSync(path.join(f.packages, broken.id, "assets/theme.json"), "{broken");
  const result = await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [broken, valid] } }));
  assert.equal(result.state, "selected"); assert.equal(f.read().themeId, "fixture:one"); assert.ok(result.diagnostic);
});
test("missing or outside-package logo preserves palette and falls back to product logo", async t => {
  const f = fixture(t), instance = f.add("io.test.theme", "fixture:one", "./../../outside.ico");
  fs.writeFileSync(path.join(f.root, "outside.ico"), "owned fixture outside package");
  const result = await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }));
  assert.equal(result.state, "selected"); assert.equal(Object.hasOwn(f.read(), "logoPath"), false); assert.ok(result.diagnostic);
  assert.equal(fs.readFileSync(path.join(f.root, "outside.ico"), "utf8"), "owned fixture outside package");
});
test("queued refresh obtains the current selection when owned work runs", async t => {
  const f = fixture(t), one = f.add("io.test.one", "fixture:one"), two = f.add("io.test.two", "fixture:two");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const first = f.projector.refresh(async () => { await gate; return { webTheme: "fixture:one", profile: { instances: [one, two] } }; });
  let selected = "fixture:one";
  const second = f.projector.refresh(async () => ({ webTheme: selected, profile: { instances: [one, two] } }));
  selected = "fixture:two"; release(); await Promise.all([first, second]);
  assert.equal(f.read().themeId, "fixture:two");
});
test("broken inputs and duplicate themes only invalidate local presentation", async t => {
  const f = fixture(t), one = f.add("io.test.one"), two = f.add("io.test.two");
  assert.equal((await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [one, two] } }))).state, "default");
  assert.equal(fs.existsSync(startupPresentationPath(f.root)), false);
  const failed = await f.projector.refresh(async () => { throw new Error("synthetic settings unavailable"); });
  assert.equal(failed.state, "unavailable");
});

function replaceStartup(f: ReturnType<typeof fixture>, instanceId: string, startup: Record<string, unknown>): void {
  const file = path.join(f.packages, instanceId, "assets/theme.json");
  const declaration = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(declaration.contributions[0].value.startup, startup);
  fs.writeFileSync(file, JSON.stringify(declaration));
}
test("custom ordered frames preserve duration and duplicate frames while copying package assets", async t => {
  const f = fixture(t), instance = f.add("io.test.frames"), directory = path.join(f.packages, instance.id, "assets");
  fs.writeFileSync(path.join(directory, "frame-one.ico"), Buffer.from([0, 0, 1, 0, 1, 1]));
  fs.writeFileSync(path.join(directory, "frame-two.ico"), Buffer.from([0, 0, 1, 0, 1, 2]));
  replaceStartup(f, instance.id, { motion: "none", frames: [
    { logo: "./assets/frame-one.ico", durationMs: 80 }, { logo: "./assets/frame-two.ico", durationMs: 120 },
    { logo: "./assets/frame-one.ico", durationMs: 2 ** 32 }
  ] });
  const declarationFile = path.join(directory, "theme.json"), before = fs.readFileSync(declarationFile);
  assert.equal((await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }))).state, "selected");
  const value = f.read(); assert.equal(value.motion, "none"); assert.deepEqual(value.frames.map((frame: { durationMs: number }) => frame.durationMs), [80, 120, 2 ** 32]);
  assert.equal(value.frames[0].logoPath, value.frames[2].logoPath); assert.notEqual(value.frames[0].logoPath, value.frames[1].logoPath);
  for (const frame of value.frames) assert.ok(path.isAbsolute(frame.logoPath));
  assert.deepEqual(fs.readFileSync(value.frames[1].logoPath), fs.readFileSync(path.join(directory, "frame-two.ico")));
  assert.deepEqual(fs.readFileSync(declarationFile), before); assert.ok(value.logoPath, "legacy static logo remains independently available");
});
test("bad or missing animation frames are local and do not discard valid frames or legacy appearance", async t => {
  const f = fixture(t), instance = f.add("io.test.frames");
  const input = f.definition() as ReturnType<typeof f.definition> & { startup: { frames?: unknown } };
  input.startup.frames = [{ logo: "./assets/logo.ico", durationMs: 0 }, { logo: "./assets/logo.ico", durationMs: 1.5 },
    { logo: "./assets/missing.ico", durationMs: 60 }, { logo: "./assets/logo.ico", durationMs: 90 }];
  assert.equal(parseStartupTheme(input)?.frames?.length, 2);
  replaceStartup(f, instance.id, { frames: input.startup.frames });
  const result = await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }));
  assert.equal(result.state, "selected"); assert.ok(result.diagnostic); assert.equal(f.read().frames.length, 1);
  assert.equal(f.read().frames[0].durationMs, 90); assert.equal(f.read().frames[0].logoPath, f.read().logoPath);
});
test("successful selection and default clean only obsolete direct SHA ICO assets", async t => {
  const f = fixture(t), instance = f.add("io.test.frames"), assets = path.join(f.root, "data/desktop/startup-theme-assets");
  fs.mkdirSync(assets, { recursive: true });
  const obsolete = path.join(assets, "a".repeat(64) + ".ico"), note = path.join(assets, "user-note.ico"), nested = path.join(assets, "nested");
  fs.writeFileSync(obsolete, "old derived bytes"); fs.writeFileSync(note, "unrelated user file"); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, "b".repeat(64) + ".ico"), "nested bytes");
  await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }));
  const current = f.read().logoPath; assert.equal(fs.existsSync(obsolete), false); assert.equal(fs.existsSync(current), true);
  assert.equal(fs.readFileSync(note, "utf8"), "unrelated user file"); assert.equal(fs.existsSync(path.join(nested, "b".repeat(64) + ".ico")), true);
  const changed = Buffer.from([0, 0, 1, 0, 4, 9]); fs.writeFileSync(path.join(f.packages, instance.id, "assets/logo.ico"), changed);
  await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }));
  const next = f.read().logoPath; assert.notEqual(next, current); assert.equal(fs.existsSync(current), false); assert.equal(fs.existsSync(next), true);
  assert.equal(path.basename(next), createHash("sha256").update(changed).digest("hex") + ".ico");
  await f.projector.refresh(async () => ({ webTheme: "system", profile: { instances: [instance] } }));
  assert.equal(fs.existsSync(next), false); assert.equal(fs.existsSync(note), true); assert.equal(fs.existsSync(nested), true);
});
test("cleanup failure retains the committed current appearance and continues unrelated cache removal", async t => {
  const f = fixture(t), instance = f.add("io.test.frames"), assets = path.join(f.root, "data/desktop/startup-theme-assets"); fs.mkdirSync(assets, { recursive: true });
  const locked = path.join(assets, "a".repeat(64) + ".ico"), removable = path.join(assets, "b".repeat(64) + ".ico"); fs.writeFileSync(locked, "locked fixture"); fs.writeFileSync(removable, "old fixture");
  const unlink = fs.promises.unlink;
  t.mock.method(fs.promises, "unlink", async (...args: Parameters<typeof unlink>) => {
    if (String(args[0]) === locked) throw Object.assign(new Error("fixture cache locked"), { code: "EACCES" });
    return Reflect.apply(unlink, fs.promises, args);
  });
  const result = await f.projector.refresh(async () => ({ webTheme: "fixture:one", profile: { instances: [instance] } }));
  assert.equal(result.state, "selected"); assert.ok(result.diagnostic); assert.equal(fs.existsSync(f.read().logoPath), true);
  assert.equal(fs.existsSync(locked), true); assert.equal(fs.existsSync(removable), false);
});
test("builtin choices preserve explicit light or dark without resolving any installed package", async t => {
  const f = fixture(t), instance = f.add("io.test.frames"); let resolutions = 0;
  const projector = createStartupPresentationProjector({ stateRoot: f.root, resolvePackage: async () => { resolutions++; throw new Error("builtin must not resolve packages"); } });
  for (const webTheme of ["dark", "light"]) {
    assert.equal((await projector.refresh(async () => ({ webTheme, profile: { instances: [instance] } }))).state, "selected");
    assert.equal(f.read().themeId, webTheme); assert.equal(f.read().light.background, "#f6f8fb"); assert.equal(f.read().dark.background, "#121a22");
  }
  assert.equal((await projector.refresh(async () => ({ webTheme: "system", profile: { instances: [instance] } }))).state, "default");
  assert.equal(fs.existsSync(startupPresentationPath(f.root)), false); assert.equal(resolutions, 0);
});
test("stop joins accepted atomic publication and rejects later refresh without reading inputs", async t => {
  const f = fixture(t); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const accepted = f.projector.refresh(async () => { entered(); await gate; return { webTheme: "dark", profile: { instances: [] } }; });
  await started; let stopped = false; const stopping = f.projector.stop().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release(); assert.equal((await accepted).state, "selected"); await stopping; assert.equal(f.read().themeId, "dark");
  let read = false; assert.equal((await f.projector.refresh(async () => { read = true; throw new Error("must not enter"); })).state, "unavailable");
  assert.equal(read, false); await f.projector.stop();
});

test("default cache cleanup never follows a directory junction into another owner", async t => {
  const f = fixture(t), assets = path.join(f.root, "data/desktop/startup-theme-assets"), foreign = path.join(f.root, "foreign-owner");
  fs.mkdirSync(path.dirname(assets), { recursive: true }); fs.mkdirSync(foreign);
  const foreignAsset = path.join(foreign, "a".repeat(64) + ".ico"); fs.writeFileSync(foreignAsset, "other owner bytes");
  fs.symlinkSync(foreign, assets, "junction");
  const result = await f.projector.refresh(async () => ({ webTheme: "system", profile: { instances: [] } }));
  assert.equal(result.state, "default"); assert.ok(result.diagnostic); assert.equal(fs.readFileSync(foreignAsset, "utf8"), "other owner bytes");
  assert.equal(fs.lstatSync(assets).isSymbolicLink(), true);
});
