import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createPersonaSkillOperations, type PersonaSkillContext } from "./personaSkillOperations.js";
import { listRoleSkills, getRoleSkill } from "../../../../roleKnowledge.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";

function document(id: string, text: string): string {
  return `---\nid: ${id}\ntitle: Example ${id}\nsummary: Controlled example\nkeywords: [fixture]\n---\n# Example\n${text}\n`;
}
async function fixture(t: any, options: { onSkillsChanged?: PersonaSkillContext["onSkillsChanged"] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "role-skill-write-")), roleDir = path.join(directory, "Example");
  await fs.mkdir(path.join(roleDir, "skills", "bundle", "references"), { recursive: true });
  await fs.writeFile(path.join(roleDir, "persona.md"), "# Example");
  await fs.writeFile(path.join(roleDir, "skills", "bundle", "SKILL.md"), document("selected", "Original content"));
  await fs.writeFile(path.join(roleDir, "skills", "bundle", "references", "original.md"), "Original supporting content");
  let changed = 0;
  const context: PersonaSkillContext = { roleDirectory: () => roleDir,
    querySkills: async (dir, id) => id ? getRoleSkill(dir, id) : listRoleSkills(dir),
    archive: async () => { throw new Error("This fixture does not request ZIP downloads."); },
    reportCleanupError: () => {}, onSkillsChanged: async (...args) => { changed++; await options.onSkillsChanged?.(...args); }
  };
  const registry = new ManagerPluginRouteRegistry(), registration = registry.registerOperations("persona", createPersonaSkillOperations(context));
  const server = http.createServer((request, response) => { markAuthenticatedConnectionRequest(request); if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = async (suffix: string, method = "GET", body?: unknown, key?: string, revision?: string) => {
    const response = await fetch(base + "/api/roles/Example/skills" + suffix, { method,
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}), ...(revision ? { "if-match": revision } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, etag: response.headers.get("etag"), body: await response.json() };
  };
  const operation = async (requestId: string) => { const response = await fetch(base + "/api/roles/Example/skill-operations/" + encodeURIComponent(requestId)); return { status: response.status, body: await response.json() }; };
  return { directory, roleDir, call, operation, changed: () => changed, context };
}

test("public Skill create/read/update preserves full documents, supporting files, revision and original request receipts", async t => {
  const f = await fixture(t), original = document("new", "New reusable method");
  const created = await f.call("", "POST", { id: "new", content: original, files: { "references/guide.md": "Guide" } }, "create-new");
  assert.equal(created.status, 201); assert.equal(created.body.data.document, original); assert.equal(f.changed(), 1);
  const receipt = await f.operation("create-new"); assert.equal(receipt.status, 200); assert.equal(receipt.body.data.state, "committed"); assert.equal(receipt.body.data.result.id, "new");
  assert.equal("staged" in receipt.body.data, false); assert.equal("backup" in receipt.body.data, false);
  const replay = await f.call("", "POST", { id: "new", files: { "references/guide.md": "Guide" }, content: original }, "create-new");
  assert.equal(replay.status, 201); assert.equal(f.changed(), 1); assert.equal(replay.etag, created.etag);
  const read = await f.call("/new/source"); assert.equal(read.status, 200); assert.equal(read.etag, created.etag); assert.equal(read.body.data.files.length, 2);
  const updated = await f.call("/new", "PUT", { content: document("new", "Improved method"), files: { "references/extra.md": "Extra" } }, "update-new", read.etag!);
  assert.equal(updated.status, 200); assert.notEqual(updated.etag, read.etag); assert.equal(f.changed(), 2);
  assert.equal(await fs.readFile(path.join(f.roleDir, "skills/new/references/guide.md"), "utf8"), "Guide");
  const stale = await f.call("/new", "PUT", { content: original }, "stale-new", read.etag!); assert.equal(stale.status, 412);
  const conflict = await f.call("", "POST", { id: "new", content: document("new", "Different intent") }, "create-new"); assert.equal(conflict.status, 409);
  assert.match((await f.call("/new/source")).body.data.document, /Improved method/);
});

test("updating an indexed directory id keeps its original folder and deleting it preserves an owned recovery copy", async t => {
  const f = await fixture(t), read = await f.call("/selected/source");
  assert.equal(read.status, 200);
  const update = await f.call("/selected", "PUT", { content: document("selected", "Updated original folder") }, "update-selected", read.etag!);
  assert.equal(update.status, 200); assert.equal(await fs.readFile(path.join(f.roleDir, "skills/bundle/references/original.md"), "utf8"), "Original supporting content");
  assert.equal(await fs.stat(path.join(f.roleDir, "skills/selected")).then(() => true, () => false), false);
  const removed = await f.call("/selected", "DELETE", undefined, "delete-selected", update.etag!); assert.equal(removed.status, 200); assert.equal(removed.body.data.deleted, true);
  assert.equal((await f.call("/selected/source")).status, 404); assert.equal((await f.call("/selected", "DELETE", undefined, "delete-selected", update.etag!)).status, 200);
  const work = path.join(f.directory, ".role-state/work/skills"); const entries = await fs.readdir(work);
  assert.equal(entries.length, 1); assert.match(await fs.readFile(path.join(work, entries[0], "previous/SKILL.md"), "utf8"), /Updated original folder/);
});

test("flat legacy Skill updates use the same stable revision and retain their path", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.roleDir, "skills/legacy.md"), document("flat-id", "Legacy"));
  const read = await f.call("/flat-id/source"); assert.equal(read.status, 200);
  const update = await f.call("/flat-id", "PUT", { content: document("flat-id", "Legacy updated") }, "update-flat", read.etag!); assert.equal(update.status, 200);
  const current = await f.call("/flat-id/source"); assert.equal(current.etag, update.etag); assert.match(await fs.readFile(path.join(f.roleDir, "skills/legacy.md"), "utf8"), /Legacy updated/);
});

test("invalid supporting paths, document identities and missing write preconditions are local errors without changing the Skill", async t => {
  const f = await fixture(t), read = await f.call("/selected/source"), before = await fs.readFile(path.join(f.roleDir, "skills/bundle/SKILL.md"));
  assert.equal((await f.call("/selected", "PUT", { content: document("selected", "Missing key") }, undefined, read.etag!)).status, 400);
  const missingRevision = await f.call("/selected", "PUT", { content: document("selected", "Missing revision") }, "missing-version");
  assert.equal(missingRevision.status, 400); assert.equal(missingRevision.body.errorCode, "API_REQUEST_SCHEMA_INVALID"); assert.equal(missingRevision.body.field, "headers.if-match");
  assert.equal((await f.call("/selected", "PUT", { files: { "../escape.md": "Bad" } }, "bad-path", read.etag!)).status, 400);
  assert.equal((await f.call("/selected", "PUT", { content: document("different", "Bad identity") }, "bad-id", read.etag!)).status, 400);
  assert.deepEqual(await fs.readFile(path.join(f.roleDir, "skills/bundle/SKILL.md")), before);
  assert.equal((await f.call("/selected/source")).etag, read.etag);
});

test("a failed replacement restores the original Skill before releasing its owner", async t => {
  const f = await fixture(t), read = await f.call("/selected/source"), before = await fs.readFile(path.join(f.roleDir, "skills/bundle/SKILL.md"));
  const rename = fs.rename.bind(fs); let rejected = false;
  t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (!rejected && path.basename(String(source)) === "next" && String(destination).endsWith(path.join("skills", "bundle"))) { rejected = true; throw Object.assign(new Error("Controlled install failure"), { code: "EACCES" }); }
    return rename(source, destination);
  });
  assert.equal((await f.call("/selected", "PUT", { content: document("selected", "Must roll back") }, "replacement-failure", read.etag!)).status, 500);
  t.mock.restoreAll(); assert.equal(rejected, true); assert.deepEqual(await fs.readFile(path.join(f.roleDir, "skills/bundle/SKILL.md")), before);
  assert.equal((await f.call("/selected/source")).etag, read.etag);
});

test("a catalog refresh failure reports committed storage without rolling it back", async t => {
  const f = await fixture(t, { onSkillsChanged: () => { throw new Error("Controlled projection failure"); } }), read = await f.call("/selected/source");
  const result = await f.call("/selected", "PUT", { content: document("selected", "Committed despite projection warning") }, "projection-warning", read.etag!);
  assert.equal(result.status, 200); assert.equal(result.body.data.mutationOutcome, "committed"); assert.deepEqual(result.body.data.warnings, ["SKILL_CATALOG_REFRESH_FAILED"]);
  assert.match((await f.call("/selected/source")).body.data.document, /Committed despite projection warning/);
});


test("standard name/description Skill documents remain indexable and retain their original frontmatter", async t => {
  const f = await fixture(t), raw = "---\nname: standard\ndescription: A reusable controlled method.\n---\n# Standard\nFollow the verified steps.\n";
  const created = await f.call("", "POST", { id: "standard", content: raw }, "create-standard");
  assert.equal(created.status, 201); assert.equal(created.body.data.title, "standard"); assert.deepEqual(created.body.data.keywords, []);
  assert.equal((await f.call("/standard/source")).body.data.document, raw);
});

test("competing Skill edits cannot both commit against the same source revision", async t => {
  const f = await fixture(t), original = await f.call("/selected/source");
  const results = await Promise.all([
    f.call("/selected", "PUT", { content: document("selected", "First edit") }, "concurrent-first", original.etag!),
    f.call("/selected", "PUT", { content: document("selected", "Second edit") }, "concurrent-second", original.etag!)
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409 || result.status === 412).length, 1);
  const source = await f.call("/selected/source"); assert.match(source.body.data.document, /First edit|Second edit/);
});


test("an external resource edit during preparation is preserved by the final source revision check", async t => {
  const f = await fixture(t), read = await f.call("/selected/source"), copy = fs.cp.bind(fs);
  let changed = false;
  t.mock.method(fs, "cp", async (...args: Parameters<typeof fs.cp>) => {
    const result = await copy(...args);
    if (!changed) { changed = true; await fs.writeFile(path.join(f.roleDir, "skills/bundle/references/original.md"), "External user edit"); }
    return result;
  });
  const result = await f.call("/selected", "PUT", { content: document("selected", "Prepared edit") }, "external-edit", read.etag!);
  t.mock.restoreAll(); assert.equal(changed, true); assert.equal(result.status, 412);
  assert.equal(await fs.readFile(path.join(f.roleDir, "skills/bundle/references/original.md"), "utf8"), "External user edit");
  assert.match((await f.call("/selected/source")).body.data.document, /Original content/);
});


test("a duplicate Skill id isolates only that edit and leaves another catalog entry usable", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.roleDir, "skills/duplicate"));
  await fs.writeFile(path.join(f.roleDir, "skills/duplicate/SKILL.md"), document("selected", "Duplicate identity"));
  const duplicate = await f.call("/selected/source"); assert.equal(duplicate.status, 409); assert.equal(duplicate.body.errorCode, "SKILL_ID_CONFLICT");
  const created = await f.call("", "POST", { id: "healthy", content: document("healthy", "Healthy entry") }, "create-healthy"); assert.equal(created.status, 201);
  assert.equal((await f.call("/healthy/source")).status, 200);
});


test("a late external resource edit is restored after the source moves to its recovery location", async t => {
  const f = await fixture(t), read = await f.call("/selected/source");
  const destination = path.join(f.roleDir, "skills/bundle"), supporting = path.join(destination, "references/original.md");
  const rename = fs.rename.bind(fs); let injected = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!injected && String(args[0]) === destination && path.basename(String(args[1])) === "previous") {
      injected = true; await fs.writeFile(supporting, "External edit after prepared journal");
    }
    return rename(...args);
  });
  const result = await f.call("/selected", "PUT", { content: document("selected", "Prepared edit") }, "late-resource-edit", read.etag!);
  t.mock.restoreAll(); assert.equal(injected, true); assert.equal(result.status, 412);
  assert.equal(await fs.readFile(supporting, "utf8"), "External edit after prepared journal");
  assert.match((await f.call("/selected/source")).body.data.document, /Original content/);
});

test("an unconfirmed replacement rollback retains the original request receipt and both source copies", async t => {
  const f = await fixture(t), read = await f.call("/selected/source"), destination = path.join(f.roleDir, "skills/bundle");
  const rename = fs.rename.bind(fs); let injected = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!injected && path.basename(String(args[0])) === "next" && String(args[1]) === destination) {
      injected = true; await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "SKILL.md"), document("selected", "External replacement survives"));
      throw Object.assign(new Error("Controlled stage publication failure"), { code: "EIO" });
    }
    return rename(...args);
  });
  const result = await f.call("/selected", "PUT", { content: document("selected", "Prepared replacement") }, "rollback-uncertain", read.etag!);
  t.mock.restoreAll(); assert.equal(injected, true); assert.ok(result.status >= 400);
  const receipt = await f.operation("rollback-uncertain"); assert.equal(receipt.status, 200); assert.equal(receipt.body.data.state, "prepared");
  assert.equal(receipt.body.data.mutationOutcome, "unknown");
  assert.match(await fs.readFile(path.join(destination, "SKILL.md"), "utf8"), /External replacement survives/);
  const work = path.join(f.directory, ".role-state/work/skills"), entries = await fs.readdir(work);
  assert.equal(entries.length, 1); assert.match(await fs.readFile(path.join(work, entries[0], "previous/SKILL.md"), "utf8"), /Original content/);
});


test("an uncertain delete never reconciles a changed recovery copy as the original revision", async t => {
  const f = await fixture(t), read = await f.call("/selected/source"), destination = path.join(f.roleDir, "skills/bundle");
  const rename = fs.rename.bind(fs); let injected = false;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!injected && String(args[0]) === destination && path.basename(String(args[1])) === "previous") {
      injected = true; await fs.writeFile(path.join(destination, "references/original.md"), "External edit before delete");
    }
    if (path.basename(String(args[0])) === "previous" && String(args[1]) === destination) {
      throw Object.assign(new Error("Controlled restore failure"), { code: "EIO" });
    }
    return rename(...args);
  });
  const result = await f.call("/selected", "DELETE", undefined, "uncertain-delete", read.etag!);
  t.mock.restoreAll(); assert.equal(result.status, 409); assert.equal(result.body.errorCode, "SKILL_REQUEST_UNCERTAIN");
  const replay = await f.call("/selected", "DELETE", undefined, "uncertain-delete", read.etag!); assert.equal(replay.status, 409);
  const receipt = await f.operation("uncertain-delete"); assert.equal(receipt.status, 200); assert.equal(receipt.body.data.state, "prepared");
  const work = path.join(f.directory, ".role-state/work/skills"), entries = await fs.readdir(work);
  assert.equal(await fs.readFile(path.join(work, entries[0], "previous/references/original.md"), "utf8"), "External edit before delete");
});
