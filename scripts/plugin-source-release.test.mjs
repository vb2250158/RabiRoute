import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bumpPluginVersion } from "./bump-plugin-version.mjs";
import { exportPluginSource } from "./export-plugin-source.mjs";
import { rewriteHostApiImports } from "./rewrite-built-host-api-imports.mjs";
import { buildPluginPackages } from "./build-plugin-packages.mjs";

test("a plugin release preserves host and unrelated package versions and migrates only its original references", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"rabi-plugin-release-"));
  try {
    const folder=path.join(root,"src/plugins/io.test.one"); await fs.mkdir(folder,{recursive:true});
    await fs.mkdir(path.join(root,"plugins/profiles"),{recursive:true});
    for(const [file,value] of Object.entries({"package.json":{version:"0.7.0"},"src/plugins/io.test.one/package.json":{name:"io.test.one",version:"0.1.1"},"src/plugins/io.test.one/rabi.plugin.json":{id:"io.test.one",version:"0.1.1"},"plugins/profiles/desktop.json":{instances:[{id:"saved-id",package:"io.test.one",version:"0.1.1",enabled:false,config:{value:12}},{id:"two",package:"io.test.two",version:"0.1.1"}]},"plugins/profiles/package-migrations.json":{schemaVersion:1,packages:[{packageId:"io.test.one",fromVersions:["1.0.0"],toVersion:"0.1.1"}]}}))await fs.writeFile(path.join(root,file),JSON.stringify(value));
    const host=await fs.readFile(path.join(root,"package.json"),"utf8");
    await bumpPluginVersion(root,"io.test.one","0.1.2");
    assert.equal(await fs.readFile(path.join(root,"package.json"),"utf8"),host);
    const profile=JSON.parse(await fs.readFile(path.join(root,"plugins/profiles/desktop.json"),"utf8"));
    assert.deepEqual(profile.instances[0],{id:"saved-id",package:"io.test.one",version:"0.1.2",enabled:false,config:{value:12}});
    assert.equal(profile.instances[1].version,"0.1.1");
    const migrations=JSON.parse(await fs.readFile(path.join(root,"plugins/profiles/package-migrations.json"),"utf8"));
    assert.deepEqual(migrations.packages[0],{packageId:"io.test.one",fromVersions:["1.0.0","0.1.1"],toVersion:"0.1.2"});
    await assert.rejects(bumpPluginVersion(root,"io.test.one","0.1.1"),/increase/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test("source export keeps public defaults and implementation but excludes local credentials, saves and build outputs",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"rabi-plugin-export-"));
  const target=root+"-export";
  try{
    const folder=path.join(root,"src/plugins/io.test.one");await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(root,"LICENSE"),"MIT");
    for(const [file,value] of Object.entries({"rabi.plugin.json":'{"id":"io.test.one","version":"0.1.1"}',"route-config.json":'{"default":"localhost"}',"config.json":'{"token":"private-test-value"}',"credentials.json":"private",".env":"private",".env.example":"TOKEN=change-me","src/owner.ts":"export const owner=true;","data/save.json":"private","node_modules/dependency/index.js":"private","web/node_modules/nested.json":"private"})){
      const dest=path.join(folder,file);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,value);
    }
    await exportPluginSource(root,"io.test.one",target);
    assert.equal(await fs.readFile(path.join(target,"route-config.json"),"utf8"),'{"default":"localhost"}');
    assert.equal(await fs.readFile(path.join(target,"src/owner.ts"),"utf8"),"export const owner=true;");
    assert.equal(await fs.readFile(path.join(target,".env.example"),"utf8"),"TOKEN=change-me");
    for(const file of ["config.json","credentials.json",".env","data/save.json","node_modules/dependency/index.js","web/node_modules/nested.json"])await assert.rejects(fs.access(path.join(target,file)));
    await assert.rejects(exportPluginSource(root,"io.test.one",target),/already exists/);
  }finally{await fs.rm(root,{recursive:true,force:true});await fs.rm(target,{recursive:true,force:true});}
});

test("compiled host API references resolve to the same native owner namespace",()=>{
 const root=path.resolve("candidate/dist"), file=path.join(root,"plugins/io.test.one/src/implementation.js");
 const result=rewriteHostApiImports('import { read } from "@rabiroute/host-api/shared/owner";',file,root);
 assert.equal(path.resolve(path.dirname(file),result.match(/from "([^"]+)"/)[1]),path.join(root,"shared/owner.js"));
 assert.throws(()=>rewriteHostApiImports('import "@rabiroute/host-api/../../private";',file,root),/escapes/);
});

test("export and runtime build exclude private artifacts but retain auth implementation and public definitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-public-artifacts-"));
  const target = root + "-export";
  const source = path.join(root, "src/plugins/io.test.public");
  const publicFiles = {
    "rabi.plugin.json": JSON.stringify({schemaVersion: 2, id: "io.test.public", version: "1.0.0", entries: {manager: {execution: "in_process", module: "./manager.mjs"}}, provides: [], requires: [], optional: [], permissions: []}),
    "manager.mjs": "export function activate() {}\n",
    "src/auth/owner.ts": "export const owner = true;\n",
    "src/auth/owner.py": "OWNER = True\n",
    "schemas/auth.schema.json": '{"type":"object","properties":{"token":{"type":"string"}}}',
    "examples/credentials.example.json": '{"token":"REPLACE_ME"}',
    "examples/settings.local.example.json": '{"token":"REPLACE_ME"}',
    "defaults/settings.json": '{"endpoint":"http://localhost"}',
    "config.default.json": '{"token":""}',
    ".env.example": "TOKEN=REPLACE_ME\n"
  };
  const privateFiles = ["private.pem", "auth.key", "nested/CLIENT.PEM", "nested/client.pfx", "nested/signing.p8", "nested/login.sqlite", "nested/login.sqlite-wal", "nested/session.sqlite3-journal", "nested/state.db-shm", ".venv/pyvenv.cfg", "tools/.venv/pyvenv.cfg", "python/__pycache__/owner.pyc", "owner.pyo"];
  try {
    await fs.mkdir(source, {recursive: true});
    await fs.writeFile(path.join(root, "LICENSE"), "MIT\n");
    for (const [file, contents] of Object.entries(publicFiles)) {
      await fs.mkdir(path.dirname(path.join(source, file)), {recursive: true});
      await fs.writeFile(path.join(source, file), contents);
    }
    for (const file of privateFiles) {
      await fs.mkdir(path.dirname(path.join(source, file)), {recursive: true});
      await fs.writeFile(path.join(source, file), "fake private fixture; no real credential");
    }
    await fs.mkdir(path.join(root, "plugins/profiles"), {recursive: true});
    await fs.writeFile(path.join(root, "plugins/profiles/desktop.json"), JSON.stringify({schemaVersion: 2, readyRequires: [], instances: [{id: "public", package: "io.test.public", version: "1.0.0", enabled: true, config: {}, grants: []}]}));
    await fs.mkdir(path.join(root, "plugins/contracts/plugin-sdk"), {recursive: true});
    await fs.writeFile(path.join(root, "plugins/contracts/plugin-sdk/index.mjs"), "export const definePlugin = value => value;\n");
    await assert.rejects(exportPluginSource(root, "io.test.public", path.join(root, "..candidate")), /outside/);
    await exportPluginSource(root, "io.test.public", target);
    const built = await buildPluginPackages(root);
    const runtime = path.join(built.packagesRoot, "io.test.public/1.0.0");
    for (const output of [target, runtime]) {
      for (const [file, contents] of Object.entries(publicFiles)) assert.equal(await fs.readFile(path.join(output, file), "utf8"), contents, file);
      for (const file of privateFiles) await assert.rejects(fs.access(path.join(output, file)), {code: "ENOENT"}, file);
    }
    const evidence = JSON.parse(await fs.readFile(path.join(built.outputRoot, "build-evidence.json"), "utf8"));
    for (const file of privateFiles) assert.equal(evidence.inputs.files.some(item => item.path === `src/plugins/io.test.public/${file}`), false, file);
    for (const file of privateFiles) assert.equal(await fs.readFile(path.join(source, file), "utf8"), "fake private fixture; no real credential");
  } finally {
    await fs.rm(root, {recursive: true, force: true});
    await fs.rm(target, {recursive: true, force: true});
  }
});

test("external Codex releases align the authoritative manifest and npm metadata without touching the host", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-codex-release-"));
  try {
    const directory = path.join(root, "src/plugins/rabi-codex-context");
    await fs.mkdir(path.join(directory, ".codex-plugin"), {recursive: true});
    const host = '{"name":"host","version":"0.7.0"}\n';
    await fs.writeFile(path.join(root, "package.json"), host);
    for (const [file, document] of Object.entries({
      ".codex-plugin/plugin.json": {name: "rabi-codex-context", version: "0.4.0", description: "Public context integration"},
      "package.json": {name: "rabi-codex-context", version: "0.4.0"},
      "package-lock.json": {name: "rabi-codex-context", version: "0.4.0", packages: {"": {name: "rabi-codex-context", version: "0.4.0"}}}
    })) await fs.writeFile(path.join(directory, file), JSON.stringify(document));
    await bumpPluginVersion(root, "rabi-codex-context", "0.4.1");
    for (const file of [".codex-plugin/plugin.json", "package.json", "package-lock.json"]) assert.equal(JSON.parse(await fs.readFile(path.join(directory, file), "utf8")).version, "0.4.1");
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "package-lock.json"), "utf8")).packages[""].version, "0.4.1");
    await fs.writeFile(path.join(directory, ".codex-plugin/plugin.json"), JSON.stringify({name: "rabi-codex-context", version: "0.3.0"}));
    await assert.rejects(bumpPluginVersion(root, "rabi-codex-context", "0.4.2"), /versions disagree/);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")).version, "0.4.1");
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), host);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test("local-service releases update only project.version and reject a missing authoritative project version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-service-release-"));
  try {
    const directory = path.join(root, "src/plugins/rabi-speech");
    await fs.mkdir(directory, {recursive: true});
    const manifest = JSON.stringify({id: "rabi-speech", kind: "local-service", version: "0.1.1"});
    const host = '{"version":"0.7.0"}\n';
    await fs.writeFile(path.join(root, "package.json"), host);
    await fs.writeFile(path.join(directory, "rabi-plugin.json"), manifest);
    await fs.writeFile(path.join(directory, "pyproject.toml"), "[project]\nname = 'rabi-speech'\nversion = '0.1.1' # release\n\n[tool.fixture]\nversion = '9.9.9'\n");
    await bumpPluginVersion(root, "rabi-speech", "0.1.2");
    assert.equal(await fs.readFile(path.join(directory, "pyproject.toml"), "utf8"), "[project]\nname = 'rabi-speech'\nversion = '0.1.2' # release\n\n[tool.fixture]\nversion = '9.9.9'\n");
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "rabi-plugin.json"), "utf8")).version, "0.1.2");
    const missing = '[project]\nname = "rabi-speech"\n\n[tool.fixture]\nversion = "0.1.2"\n';
    await fs.writeFile(path.join(directory, "pyproject.toml"), missing);
    await assert.rejects(bumpPluginVersion(root, "rabi-speech", "0.1.3"), /project version/);
    assert.equal(await fs.readFile(path.join(directory, "pyproject.toml"), "utf8"), missing);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "rabi-plugin.json"), "utf8")).version, "0.1.2");
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), host);
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});
