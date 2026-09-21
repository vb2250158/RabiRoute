import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentResourceCatalog, AgentResourceCatalogError, type AgentResourceErrorCode } from "./agentResourceCatalog.js";

async function fixture(context: { after(action: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-resource-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const rootDir = path.join(root, "package");
  await fs.mkdir(rootDir);
  async function write(id: string, content: string | Buffer) {
    const filename = path.join(rootDir, id);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content);
  }
  return { root, rootDir, write, catalog: new AgentResourceCatalog({ rootDir }) };
}
function denied(code: AgentResourceErrorCode) {
  return (error: unknown) => error instanceof AgentResourceCatalogError && error.code === code;
}

test("installed Manager wires public resources to packageRoot, never mutable stateRoot", async () => {
  const source = await fs.readFile(new URL("./controlPlaneRoutes.ts", import.meta.url), "utf8");
  assert.match(source, /agentResourceCatalog:\s*new AgentResourceCatalog\(\{\s*rootDir:\s*packageRoot\s*\}\)/);
});

test("split installed layout reproduces empty state catalog and reads packaged contracts", async context => {
  const sample = await fixture(context);
  const stateRoot = path.join(sample.root, "state");
  await fs.mkdir(stateRoot);
  await sample.write("skills/sample/SKILL.md", "# Public skill\n");
  await sample.write("docs/rabi-agent-interfaces.md", "Public API contract\n");
  assert.deepEqual(await new AgentResourceCatalog({ rootDir: stateRoot }).list(), []);
  const entries = await sample.catalog.list();
  assert.deepEqual(entries.map(entry => entry.id).sort(), ["docs/rabi-agent-interfaces.md", "skills/sample/SKILL.md"]);
  assert.equal((await sample.catalog.read("docs/rabi-agent-interfaces.md")).content, "Public API contract\n");
});

test("discovers manifest metadata and returns original text, stable relative IDs and byte hashes without executing scripts", async context => {
  const sample = await fixture(context);
  const manifest = '---\nname: "sample"\ndescription: >-\n  第一行\n  第二行\n---\n[guide](references/guide.md#section)\nRun `scripts/helper.mjs`.\n';
  const script = 'throw new Error("must never execute");\n';
  await sample.write("skills/sample/SKILL.md", manifest);
  await sample.write("skills/sample/references/guide.md", "# 指南\n");
  await sample.write("skills/sample/scripts/helper.mjs", script);
  await sample.write("skills/sample/private.txt", "not published");
  await sample.write("skills/incomplete/README.md", "not a skill");
  await sample.write("docs/rabi-agent-interfaces.md", "contract\n");
  const entries = await sample.catalog.list();
  assert.deepEqual(entries.map(entry => entry.id), ["docs/rabi-agent-interfaces.md", "skills/sample/SKILL.md"]);
  const skill = entries.find(entry => entry.kind === "skill")!;
  assert.equal(skill.name, "sample");
  assert.equal(skill.description, "第一行 第二行");
  assert.deepEqual(skill.references, ["skills/sample/references/guide.md", "skills/sample/scripts/helper.mjs"]);
  const content = await sample.catalog.read(skill.id);
  assert.deepEqual(content, { id: skill.id, content: manifest, sizeBytes: Buffer.byteLength(manifest), sha256: createHash("sha256").update(manifest).digest("hex") });
  assert.equal((await sample.catalog.read(skill.references[1])).content, script);
  await assert.rejects(sample.catalog.read("skills/sample/private.txt"), denied("not_found"));
  await sample.write("skills/sample/SKILL.md", "# changed\n");
  assert.notEqual((await sample.catalog.read(skill.id)).sha256, content.sha256);
  await assert.rejects(sample.catalog.read("skills/sample/scripts/helper.mjs"), denied("not_found"));
});

test("listing advertises only readable same-skill support files, not inline source examples", async context => {
  const sample = await fixture(context);
  await sample.write("skills/sample/SKILL.md", "`src/manager.ts` `config.json` [missing](references/missing.md) [real](references/real.md) `scripts/helper.mjs`\n");
  await sample.write("src/manager.ts", "outside the skill package");
  await sample.write("config.json", "{}");
  await sample.write("skills/sample/references/real.md", "real support");
  await sample.write("skills/sample/scripts/helper.mjs", "// support script, never executed");
  assert.deepEqual((await sample.catalog.list())[0].references, ["skills/sample/references/real.md", "skills/sample/scripts/helper.mjs"]);
  await assert.rejects(sample.catalog.read("skills/sample/src/manager.ts"), denied("not_found"));
  await assert.rejects(sample.catalog.read("src/manager.ts"), denied("not_found"));
  for (const id of (await sample.catalog.list())[0].references) assert.equal((await sample.catalog.read(id)).id, id);
});

test("listing omits unsafe and oversized support links but manifest failures remain closed", async context => {
  const sample = await fixture(context);
  await sample.write("skills/sample/SKILL.md", "`linked.txt` `refs/guide.md` `binary.txt` `large.txt` `good.txt`\n");
  await sample.write("skills/sample/good.txt", "safe");
  await sample.write("skills/sample/binary.txt", Buffer.from([0]));
  await sample.write("skills/sample/large.txt", "x".repeat(129));
  const outside = path.join(sample.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "guide.md"), "outside");
  await fs.link(path.join(outside, "guide.md"), path.join(sample.rootDir, "skills/sample/linked.txt"));
  await fs.symlink(outside, path.join(sample.rootDir, "skills/sample/refs"), process.platform === "win32" ? "junction" : "dir");
  const catalog = new AgentResourceCatalog({ rootDir: sample.rootDir, maxResourceBytes: 128 });
  assert.deepEqual((await catalog.list())[0].references, ["skills/sample/good.txt"]);
  await sample.write("skills/sample/SKILL.md", Buffer.from([0]));
  await assert.rejects(catalog.list(), denied("unsafe_resource"));
  await sample.write("skills/sample/SKILL.md", "x".repeat(129));
  await assert.rejects(catalog.list(), denied("too_large"));
});

test("explicit docs publication never grants arbitrary root or business file access", async context => {
  const sample = await fixture(context);
  for (const id of ["docs/extra/guide.md", "docs/not-public.md", "data/private.md", "Home/private.md", "private.md"]) await sample.write(id, "not a business mirror");
  const catalog = new AgentResourceCatalog({ rootDir: sample.rootDir, publicDocs: ["extra/guide.md"] });
  assert.deepEqual((await catalog.list()).map(entry => entry.id), ["docs/extra/guide.md"]);
  assert.equal((await catalog.read("docs/extra/guide.md")).content, "not a business mirror");
  for (const id of ["docs/not-public.md", "private.md"]) await assert.rejects(catalog.read(id), denied("not_found"));
  for (const id of ["data/private.md", "Home/private.md"]) await assert.rejects(catalog.read(id), denied("invalid_id"));
  for (const id of ["../private.md", "/etc/passwd", "C:/secret.txt", "a/../../data/private.md", "a/%2e%2e/private.md"]) {
    assert.throws(() => new AgentResourceCatalog({ rootDir: sample.rootDir, publicDocs: [id] }), denied("invalid_id"));
  }
});

test("rejects traversal, encoded and Windows alias IDs rather than normalizing them", async context => {
  const sample = await fixture(context);
  const invalid = ["", "/docs/a.md", "C:/docs/a.md", "C:\\docs\\a.md", "//server/share", "\\\\?\\C:\\a.md", "docs/../a.md", "docs/./a.md", "docs//a.md", "docs/%2e%2e/a.md", "docs/%252e%252e/a.md", "docs/%2fetc.md", "docs/a.md%00", "docs/a.md:stream", "docs/a.md?x", "docs/a.md#x", "docs/a.md\u0000", "docs/a.md ", "docs/a./b.md", "docs/NUL.md", "docs/COM1.md", "docs/.env", "docs/Home/a.md"];
  for (const id of invalid) await assert.rejects(sample.catalog.read(id), denied("invalid_id"), JSON.stringify(id));
});

test("unsafe references cannot publish cross-skill files, business storage or encoded targets", async context => {
  const sample = await fixture(context);
  await sample.write("skills/sample/SKILL.md", "[a](../other/file.md) [b](../../data/secret.md) [c](%2e%2e/private.md) [d](/secret.md) [e](https://example.invalid/a.md) `Home/private.md` [ok](./references/good.txt)\n");
  await sample.write("skills/sample/references/good.txt", "good");
  const entries = await sample.catalog.list();
  assert.deepEqual(entries[0].references, ["skills/sample/references/good.txt"]);
  await assert.rejects(sample.catalog.read("skills/other/file.md"), denied("not_found"));
});

test("rejects binary, invalid UTF-8, non-text extension, directories and oversized resources", async context => {
  const sample = await fixture(context);
  await sample.write("skills/sample/SKILL.md", "`zero.txt` `bad.txt` `image.png` `folder.txt` `large.txt`\n");
  await sample.write("skills/sample/zero.txt", Buffer.from([65, 0, 66]));
  await sample.write("skills/sample/bad.txt", Buffer.from([0xc3, 0x28]));
  await sample.write("skills/sample/image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.mkdir(path.join(sample.rootDir, "skills/sample/folder.txt"));
  await sample.write("skills/sample/large.txt", "x".repeat(81));
  const catalog = new AgentResourceCatalog({ rootDir: sample.rootDir, maxResourceBytes: 80 });
  for (const id of ["zero.txt", "bad.txt", "folder.txt"]) await assert.rejects(catalog.read(`skills/sample/${id}`), denied("unsafe_resource"));
  await assert.rejects(catalog.read("skills/sample/image.png"), denied("not_found"));
  await assert.rejects(catalog.read("skills/sample/large.txt"), denied("too_large"));
  await sample.write("skills/sample/large.txt", "中".repeat(27));
  await assert.rejects(catalog.read("skills/sample/large.txt"), denied("too_large"));
  await sample.write("skills/sample/large.txt", "x".repeat(80));
  assert.equal((await catalog.read("skills/sample/large.txt")).sizeBytes, 80);
});

test("rejects directory junction escape, including replacement after successful access", async context => {
  const sample = await fixture(context);
  await sample.write("skills/sample/SKILL.md", "`references/guide.md`\n");
  await sample.write("skills/sample/references/guide.md", "safe");
  assert.equal((await sample.catalog.read("skills/sample/references/guide.md")).content, "safe");
  const outside = path.join(sample.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "guide.md"), "outside");
  await fs.rm(path.join(sample.rootDir, "skills/sample/references"), { recursive: true });
  await fs.symlink(outside, path.join(sample.rootDir, "skills/sample/references"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sample.catalog.read("skills/sample/references/guide.md"), denied("unsafe_resource"));
  await fs.symlink(outside, path.join(sample.rootDir, "skills/linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sample.catalog.list(), denied("unsafe_resource"));
});

test("rejects a linked docs root and hardlinked ordinary files", async context => {
  const sample = await fixture(context);
  const outside = path.join(sample.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "rabi-agent-interfaces.md"), "outside");
  await fs.symlink(outside, path.join(sample.rootDir, "docs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(sample.catalog.read("docs/rabi-agent-interfaces.md"), denied("unsafe_resource"));
  await sample.write("skills/sample/SKILL.md", "`linked.txt`\n");
  await fs.link(path.join(outside, "rabi-agent-interfaces.md"), path.join(sample.rootDir, "skills/sample/linked.txt"));
  await assert.rejects(sample.catalog.read("skills/sample/linked.txt"), denied("unsafe_resource"));
});

test("rejects file symlinks where the platform grants creation", async context => {
  const sample = await fixture(context);
  await sample.write("skills/sample/SKILL.md", "`linked.txt`\n");
  const outside = path.join(sample.root, "outside.txt");
  await fs.writeFile(outside, "outside");
  try { await fs.symlink(outside, path.join(sample.rootDir, "skills/sample/linked.txt"), "file"); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { context.skip("Windows file-symlink privilege unavailable; junction and hardlink tests still run"); return; }
    throw error;
  }
  await assert.rejects(sample.catalog.read("skills/sample/linked.txt"), denied("unsafe_resource"));
});

test("default documents are the exact public contract set, and configuration is copied at construction", async context => {
  const sample = await fixture(context);
  const documents = ["rabi-agent-interfaces.md", "plan-and-memory-model.md", "agent-context-injection.md", "lan-rabi-agent-bootstrap.md",
    "rabi-agent-interfaces_en.md", "plan-and-memory-model_en.md", "agent-context-injection_en.md", "lan-rabi-agent-bootstrap_en.md"];
  for (const document of documents) await sample.write(`docs/${document}`, "public contract");
  await sample.write("docs/other.md", "not public by default");
  assert.deepEqual((await sample.catalog.list()).map(entry => entry.id).sort(), documents.map(document => `docs/${document}`).sort());
  await assert.rejects(sample.catalog.read("docs/other.md"), denied("not_found"));
  const configured = ["other.md"];
  const catalog = new AgentResourceCatalog({ rootDir: sample.rootDir, publicDocs: configured });
  configured.push("rabi-agent-interfaces.md");
  await assert.rejects(catalog.read("docs/rabi-agent-interfaces.md"), denied("not_found"));
});

test("BOM and UTF-8 bytes remain hash-consistent; excessive references and invalid size limits fail closed", async context => {
  const sample = await fixture(context);
  const content = "\uFEFF---\nname: bom\ndescription: '测试'\n---\n`one.txt` `two.txt`\n";
  await sample.write("skills/sample/SKILL.md", content);
  const resource = await sample.catalog.read("skills/sample/SKILL.md");
  assert.equal(resource.content, content);
  assert.equal(resource.sha256, createHash("sha256").update(resource.content).digest("hex"));
  assert.equal((await sample.catalog.list())[0].name, "bom");
  const limited = new AgentResourceCatalog({ rootDir: sample.rootDir, publicDocs: [], maxEntries: 1 });
  await assert.rejects(limited.list(), denied("catalog_limit"));
  for (const value of [0, -1, NaN, Infinity, 0.5, 8 * 1024 * 1024 + 1]) {
    assert.throws(() => new AgentResourceCatalog({ rootDir: sample.rootDir, maxResourceBytes: value }), denied("catalog_limit"));
  }
});

test("missing roots return an empty catalog, missing resources stay not_found and listing is bounded", async context => {
  const sample = await fixture(context);
  assert.deepEqual(await sample.catalog.list(), []);
  await assert.rejects(sample.catalog.read("docs/rabi-agent-interfaces.md"), denied("not_found"));
  await sample.write("skills/one/SKILL.md", "# one");
  await sample.write("skills/two/SKILL.md", "# two");
  const catalog = new AgentResourceCatalog({ rootDir: sample.rootDir, publicDocs: [], maxEntries: 1 });
  await assert.rejects(catalog.list(), denied("catalog_limit"));
  for (const value of [0, -1, Infinity, 1.5, 8193]) {
    assert.throws(() => new AgentResourceCatalog({ rootDir: sample.rootDir, maxEntries: value }), denied("catalog_limit"));
  }
});
