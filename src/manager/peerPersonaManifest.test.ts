import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPeerPersonaManifest } from "./peerPersonaManifest.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  // Resolve OS temp aliases (e.g. /var on macOS) before exercising the strict ancestor gate.
  const root = await fs.promises.mkdtemp(path.join(await fs.promises.realpath(os.tmpdir()), "peer-manifest-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const roles = path.join(root, "roles");
  await fs.promises.mkdir(path.join(roles, "Example"), { recursive: true });
  async function put(relative: string, content = "fixture") {
    const target = path.join(roles, "Example", ...relative.split("/"));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
    return target;
  }
  return { root, roles, put };
}

async function tree(directory: string): Promise<unknown[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    const target = path.join(directory, entry.name);
    const stat = await fs.promises.lstat(target);
    return [entry.name, stat.size, stat.mtimeMs, stat.ctimeMs,
      entry.isDirectory() ? await tree(target) : (await fs.promises.readFile(target)).toString("base64")];
  }));
}

test("fresh v1 manifest preserves fields, sorting and strategies without changing the tree", async t => {
  const { root, roles, put } = await fixture(t);
  await put("persona.md", "first");
  await put("memory/events.JSONL", '{"id":"example"}\n');
  await put("plans/active/example/plan.json", "not parsed or repaired by a peer inventory");
  await fs.promises.mkdir(path.join(roles, "Other"));
  await fs.promises.writeFile(path.join(roles, "Other", "private.md"), "not requested");
  const before = await tree(root);
  const manifest = await readPeerPersonaManifest(roles, "Example");
  assert.deepEqual(await tree(root), before);
  assert.deepEqual(Object.keys(manifest).sort(), ["generatedAt", "roles", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(manifest.generatedAt)));
  assert.deepEqual(manifest.roles.map(role => role.roleId), ["Example"]);
  const files = manifest.roles[0].files;
  assert.deepEqual(files.map(file => file.path), ["memory/events.JSONL", "persona.md", "plans/active/example/plan.json"]);
  const persona = files.find(file => file.path === "persona.md")!;
  assert.deepEqual(Object.keys(persona).sort(), ["mergeStrategy", "modifiedAt", "path", "roleId", "sha256", "size"]);
  assert.equal(persona.roleId, "Example");
  assert.equal(persona.size, 5);
  assert.equal(persona.sha256, createHash("sha256").update("first").digest("hex"));
  assert.equal(persona.mergeStrategy, "three-way-file");
  assert.equal(files[0].mergeStrategy, "jsonl-union");
  assert.ok(Number.isFinite(Date.parse(persona.modifiedAt)));

  await put("persona.md", "other"); // Same byte length: no size/mtime hash cache is allowed.
  await put("growth.md", "new");
  await fs.promises.unlink(path.join(roles, "Example", "memory", "events.JSONL"));
  const fresh = await readPeerPersonaManifest(roles, "Example");
  assert.equal(fresh.roles[0].files.find(file => file.path === "persona.md")?.sha256,
    createHash("sha256").update("other").digest("hex"));
  assert.ok(fresh.roles[0].files.some(file => file.path === "growth.md"));
  assert.ok(!fresh.roles[0].files.some(file => file.path === "memory/events.JSONL"));
});

test("v1 runtime exclusions and the 16 MiB file limit remain compatible", async t => {
  const { roles, put } = await fixture(t);
  const excluded = [
    ".private/item", "nested/.hidden", "nested/tmp/item", "TEMP/item", "file.tmp", "file.LOCK", "file.part",
    "state/work-cycle-history/item", "state/work-cycle-history-locks/item", "state/work-cycle-inputs/item",
    "state/work-cycle-plan-locks/item", "state/work-cycle-receipt-locks/item", "conversation/situations/item",
    "plans/items/item", "plans/history/item", "plans/feedback/item", "plans/attachments/item",
    "plans/quarantine/item", "plans/.staging/item", "plans/archive/legacy.json", "voice/cache/tts-audio/item"
  ];
  for (const relative of excluded) await put(relative);
  const large = await put("large.bin");
  await fs.promises.truncate(large, 16 * 1024 * 1024 + 1);
  const exact = await put("limit.bin");
  await fs.promises.truncate(exact, 16 * 1024 * 1024);
  await put("plans/archive/example/plan.json", "{}");
  await put("persona.md");
  const result = await readPeerPersonaManifest(roles, "Example");
  assert.deepEqual(result.roles[0].files.map(file => file.path), ["limit.bin", "persona.md", "plans/archive/example/plan.json"]);
});

test("missing roots/roles return an empty inventory without creating directories", async t => {
  const { root, roles } = await fixture(t);
  assert.deepEqual((await readPeerPersonaManifest(roles, "Missing")).roles, []);
  const absent = path.join(root, "absent");
  assert.deepEqual((await readPeerPersonaManifest(absent, "Example")).roles, []);
  await assert.rejects(fs.promises.lstat(absent), { code: "ENOENT" });
  assert.deepEqual((await readPeerPersonaManifest(roles, "Example")).roles, [{ roleId: "Example", files: [] }]);
});

test("role IDs reject traversal, absolute paths, trimming aliases, ADS and device names", async t => {
  const { roles } = await fixture(t);
  for (const roleId of ["", ".", "..", "../Other", "Example/Other", "Example\\Other", "/Example", "C:\\Example",
    " Example", "Example ", "Example:stream", "Example\0", "CON", "nul", "COM1", "LPT²"]) {
    await assert.rejects(readPeerPersonaManifest(roles, roleId), /peer_role_denied/);
  }
  await fs.promises.mkdir(path.join(roles, "示例_角色-2"));
  assert.equal((await readPeerPersonaManifest(roles, "示例_角色-2")).roles[0].roleId, "示例_角色-2");
});

test("linked roles, roots and root ancestors fail closed; nested junctions are never traversed", async t => {
  const { root, roles, put } = await fixture(t);
  await put("persona.md");
  const outside = path.join(root, "outside");
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, "private.md"), "outside fixture");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const nested = path.join(roles, "Example", "linked");
  try {
    await fs.promises.symlink(outside, nested, linkType);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Directory links unavailable on this test filesystem");
      return;
    }
    throw error;
  }
  assert.deepEqual((await readPeerPersonaManifest(roles, "Example")).roles[0].files.map(file => file.path), ["persona.md"]);
  await fs.promises.symlink(outside, path.join(roles, "Linked"), linkType);
  await assert.rejects(readPeerPersonaManifest(roles, "Linked"), /peer_persona_directory_denied/);
  const alias = path.join(root, "alias");
  await fs.promises.symlink(roles, alias, linkType);
  await assert.rejects(readPeerPersonaManifest(alias, "Example"), /peer_persona_directory_denied/);
  const parentAlias = path.join(root, "parent-alias");
  await fs.promises.mkdir(path.join(outside, "roles", "Example"), { recursive: true });
  await fs.promises.symlink(outside, parentAlias, linkType);
  await assert.rejects(readPeerPersonaManifest(path.join(parentAlias, "roles"), "Example"), /peer_persona_directory_denied/);
});

test("hard-linked files fail closed instead of exposing an outside alias", async t => {
  const { root, roles } = await fixture(t);
  const outside = path.join(root, "outside.txt");
  await fs.promises.writeFile(outside, "outside fixture");
  try {
    await fs.promises.link(outside, path.join(roles, "Example", "alias.txt"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("Hard links unavailable on this test filesystem");
      return;
    }
    throw error;
  }
  await assert.rejects(readPeerPersonaManifest(roles, "Example"), /peer_persona_file_changed/);
});

test("reader imports only Node builtins and has no writable storage API", async () => {
  const source = await fs.promises.readFile(new URL("./peerPersonaManifest.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(imports, ["node:crypto", "node:fs", "node:path"]);
  assert.doesNotMatch(source, /(?:writeFile|mkdir|rename|unlink|appendFile|watch|truncate|withPlanStorageLease|SyncManifestIndex)\s*\(/);
  assert.match(source, /fs\.constants\.O_RDONLY/);
});
