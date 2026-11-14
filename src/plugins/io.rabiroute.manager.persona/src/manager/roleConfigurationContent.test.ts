import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createRoleConfigurationOperations } from "./roleConfigurationOperations.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-content-api-"));
  await fs.mkdir(path.join(root, "Existing"));
  await fs.writeFile(path.join(root, "Existing/persona.md"), "# Existing\nOriginal text");
  await fs.writeFile(path.join(root, "Existing/personaConfig.json"), JSON.stringify({ custom: { retained: true }, speechTriggerKeywords: ["original"] }));
  let failPublication = false, enabled = true;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("role-content-fixture", createRoleConfigurationOperations({
    rolesRoot: () => root, identity: () => ({ applicationGenerationId: "fixture", managerInstanceId: "fixture" }),
    routes: () => [], assertCatalogReady() {}, changed: async (_id, assertCurrent) => {
      assertCurrent(); if (failPublication) { failPublication = false; throw new Error("Publication interrupted"); }
    }
  }));
  const server = http.createServer((request, response) => {
    Object.defineProperty(request.socket, "remoteAddress", { value: "192.0.2.25", configurable: true });
    markAuthenticatedConnectionRequest(request, () => { if (!enabled) throw new Error("Connection revoked"); });
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/roles`;
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("role-content-api-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, failPublication: () => { failPublication = true; }, revoke: () => { enabled = false; }, reconnect: () => { enabled = true; },
    async call(suffix: string, method = "GET", body?: unknown, key = "fixture-key") {
      const response = await fetch(base + suffix, { method, headers: { "content-type": "application/json", "idempotency-key": key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    }
  };
}

function quota(t: test.TestContext, name: string, value: string): void {
  const previous = process.env[name]; process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

test("full config PATCH preserves omitted keys and exposes complete data over HTTP", async t => {
  const f = await fixture(t), original = await f.call("/Existing/configuration");
  const patched = await f.call("/Existing/configuration", "PATCH", { expectedRevision: original.body.data.revision,
    config: { contextInjection: { mode: "focused" }, custom: null } }, "patch-config");
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.deepEqual(patched.body.data.config.speechTriggerKeywords, ["original"]);
  assert.equal(patched.body.data.personaConfig.custom, undefined);
  assert.equal(patched.body.data.personaConfig.contextInjection.mode, "focused");
  assert.equal((await f.call("/Existing/document")).body.data.personaConfig.contextInjection.mode, "focused");
  assert.equal((await f.call("/Existing/configuration", "PATCH", { expectedRevision: original.body.data.revision, config: { custom: "stale" } }, "stale-patch")).status, 412);
});

test("document revision covers text and configuration and document retries keep the original receipt", async t => {
  const f = await fixture(t), before = await f.call("/Existing/document");
  const payload = { expectedRevision: before.body.data.revision, document: "# Existing\nUpdated text" };
  const saved = await f.call("/Existing/document", "PUT", payload, "document-save");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.notEqual(saved.body.data.revision, before.body.data.revision);
  assert.equal(saved.body.data.configurationRevision, before.body.data.configurationRevision);
  assert.deepEqual((await f.call("/Existing/document", "PUT", payload, "document-save")).body, saved.body);
  assert.equal((await f.call("/Existing/document", "PUT", { ...payload, document: "stale" }, "document-stale")).status, 412);
  const config = await f.call("/Existing/configuration");
  await f.call("/Existing/configuration", "PATCH", { expectedRevision: config.body.data.revision, config: { custom: "changed" } }, "config-after-doc");
  assert.equal((await f.call("/Existing/document", "PUT", { expectedRevision: saved.body.data.revision, document: "older package" }, "document-after-config")).status, 412);
});

test("document pending receipt recovers publication failure and stale key does not overwrite newer edits", async t => {
  const f = await fixture(t), original = await f.call("/Existing/document"), payload = { expectedRevision: original.body.data.revision, document: "# Existing\nAccepted" };
  f.failPublication();
  assert.equal((await f.call("/Existing/document", "PUT", payload, "doc-recover")).body.uncertain, true);
  assert.equal((await f.call("/Existing/document", "PUT", payload, "doc-recover")).status, 200);
  const next = await f.call("/Existing/document");
  await f.call("/Existing/document", "PUT", { expectedRevision: next.body.data.revision, document: "# Existing\nNewest" }, "doc-newer");
  assert.equal((await f.call("/Existing/document", "PUT", payload, "doc-recover")).status, 200);
  assert.equal((await f.call("/Existing/document")).body.data.document, "# Existing\nNewest");
});

test("revocation after temporary document write preserves original text and the same pending request recovers", async t => {
  const f = await fixture(t), original = await f.call("/Existing/document"), write = fs.writeFile;
  const realDocument = path.join(await fs.realpath(path.join(f.root, "Existing")), "persona.md");
  const mocked = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    const result = await write(...args);
    if (String(args[0]).startsWith(realDocument + ".")) f.revoke();
    return result;
  });
  const payload = { expectedRevision: original.body.data.revision, document: "# Existing\nAfter reconnection" };
  const failed = await f.call("/Existing/document", "PUT", payload, "doc-revoked");
  assert.equal(failed.status, 403); assert.equal(failed.body.uncertain, true);
  assert.equal(await fs.readFile(path.join(f.root, "Existing/persona.md"), "utf8"), original.body.data.document);
  assert.equal((await fs.readdir(path.join(f.root, "Existing"))).some(file => file.endsWith(".tmp")), false);
  mocked.mock.restore(); f.reconnect();
  assert.equal((await f.call("/Existing/document", "PUT", payload, "doc-revoked")).status, 200);
  assert.equal((await f.call("/Existing/document")).body.data.document, payload.document);
});

test("unrelated configuration patches and changed healthy rules preserve malformed neighbours byte-for-byte", async t => {
  const f = await fixture(t);
  const valid = (id: string) => ({ id, name: id, trigger: { type: "message" }, action: { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" } } });
  const rules = [valid("first"), null, { id: "broken", trigger: { type: "invalid" }, action: { type: "invalid" } }, valid("last")];
  const file = path.join(f.root, "Existing/personaConfig.json");
  await fs.writeFile(file, JSON.stringify({ automationRules: rules, custom: { retained: true } }));
  const original = await f.call("/Existing/configuration");
  const unrelated = await f.call("/Existing/configuration", "PATCH", { expectedRevision: original.body.data.revision, config: { contextInjection: { mode: "focused" } } }, "unrelated-bad-rules");
  assert.equal(unrelated.status, 200, JSON.stringify(unrelated.body));
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).automationRules, rules);
  const changed = await f.call("/Existing/configuration", "PATCH", { expectedRevision: unrelated.body.data.revision,
    config: { automationRules: [{ ...rules[0], name: "Changed first" }, ...rules.slice(1)] } }, "healthy-next-to-bad");
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.automationRules[0].name, "Changed first");
  assert.deepEqual(saved.automationRules.slice(1), rules.slice(1));
  const before = await fs.readFile(file, "utf8");
  const rejected = await f.call("/Existing/configuration", "PATCH", { expectedRevision: changed.body.data.revision,
    config: { automationRules: [...saved.automationRules, null] } }, "new-invalid-entry");
  assert.equal(rejected.status, 400);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("HTTP document reads and atomic writes preserve internal file links while external targets remain unchanged", async t => {
  const f = await fixture(t), canonical = path.join(f.root, "Existing/persona.md"), target = path.join(f.root, "Existing/identity.md");
  await fs.writeFile(target, "# Linked identity\nOriginal");
  await fs.unlink(canonical);
  try { await fs.symlink(target, canonical, "file"); }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("This Windows account cannot create file symlinks; run this same HTTP test on a symlink-capable host."); return;
    }
    throw error;
  }
  const original = await f.call("/Existing/document");
  assert.equal(original.status, 200, JSON.stringify(original.body));
  assert.equal(original.body.data.document, "# Linked identity\nOriginal");
  const saved = await f.call("/Existing/document", "PUT", { expectedRevision: original.body.data.revision, document: "# Linked identity\nUpdated" }, "internal-link");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await fs.lstat(canonical)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, "utf8"), "# Linked identity\nUpdated");
  const outside = path.join(f.root, "outside.md"), outsideText = "# Outside\nKeep original";
  await fs.writeFile(outside, outsideText);
  await fs.unlink(canonical); await fs.symlink(outside, canonical, "file");
  assert.equal((await f.call("/Existing/document")).status, 403);
  const rejected = await f.call("/Existing/document", "PUT", { expectedRevision: saved.body.data.revision, document: "Forbidden replacement" }, "external-link");
  assert.equal(rejected.status, 403);
  assert.equal(await fs.readFile(outside, "utf8"), outsideText);
  assert.equal((await fs.lstat(canonical)).isSymbolicLink(), true);
});

test("default unlimited quotas support large documents, full config and original receipt replay without hidden limits", async t => {
  quota(t, "RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES", "0"); quota(t, "RABIROUTE_PERSONA_CONFIG_MAX_BYTES", "0");
  const f = await fixture(t), document = "# Large\n" + "x".repeat(9 * 1024 * 1024);
  const original = await f.call("/Existing/document");
  const payload = { expectedRevision: original.body.data.revision, document };
  const saved = await f.call("/Existing/document", "PUT", payload, "large-document");
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 300));
  assert.equal((await f.call("/Existing/document")).body.data.document, document);
  assert.equal((await f.call("/Existing/document", "PUT", payload, "large-document")).body.data.document, document);
  const config = await f.call("/Existing/configuration"), extension = "c".repeat(3 * 1024 * 1024);
  const patched = await f.call("/Existing/configuration", "PATCH", { expectedRevision: config.body.data.revision, config: { largeExtension: extension } }, "large-config");
  assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 300));
  assert.equal((await f.call("/Existing/configuration")).body.data.personaConfig.largeExtension, extension);
});

test("explicit document quota rejects excess reads and writes and invalid settings retain their real field", async t => {
  quota(t, "RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES", "32");
  const f = await fixture(t), original = await f.call("/Existing/document");
  assert.equal(original.status, 200);
  const rejected = await f.call("/Existing/document", "PUT", { expectedRevision: original.body.data.revision, document: "x".repeat(33) }, "document-quota");
  assert.equal(rejected.status, 413); assert.match(rejected.body.message, /RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES=32/);
  assert.equal(await fs.readFile(path.join(f.root, "Existing/persona.md"), "utf8"), original.body.data.document);
  process.env.RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES = "8";
  assert.equal((await f.call("/Existing/document")).status, 413);
  process.env.RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES = "invalid";
  const badSetting = await f.call("/Existing/document");
  assert.equal(badSetting.status, 503); assert.equal(badSetting.body.error, "READ_SETTING_INVALID");
  assert.match(badSetting.body.message, /RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES/);
});

test("explicit configuration quota applies to persisted bytes without changing the previous file", async t => {
  quota(t, "RABIROUTE_PERSONA_CONFIG_MAX_BYTES", "256");
  const f = await fixture(t), original = await f.call("/Existing/configuration");
  assert.equal(original.status, 200);
  const file = path.join(f.root, "Existing/personaConfig.json"), before = await fs.readFile(file, "utf8");
  const rejected = await f.call("/Existing/configuration", "PATCH", { expectedRevision: original.body.data.revision, config: { extension: "x".repeat(300) } }, "config-quota");
  assert.equal(rejected.status, 413); assert.match(rejected.body.message, /RABIROUTE_PERSONA_CONFIG_MAX_BYTES=256/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  process.env.RABIROUTE_PERSONA_CONFIG_MAX_BYTES = "8";
  assert.equal((await f.call("/Existing/configuration")).status, 413);
});

test("document lookup reports missing role without creating storage", async t => {
  const f = await fixture(t);
  const response = await f.call("/Missing/document");
  assert.equal(response.status, 404, JSON.stringify(response.body));
  assert.equal(response.body.error, "ROLE_NOT_FOUND");
  await assert.rejects(fs.stat(path.join(f.root, "Missing")), { code: "ENOENT" });
});

test("authenticated Agent creates full role in one request and replays the same receipt", async t => {
  const f = await fixture(t), payload = { roleId: "New", title: "New", document: "# New\nComplete identity", config: { contextInjection: { mode: "focused" }, speechTriggerKeywords: ["new"] } };
  const created = await f.call("", "POST", payload, "create-full");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.state, "committed");
  assert.equal(created.body.data.personaConfig.contextInjection.mode, "focused");
  const read = await f.call("/New/document");
  assert.equal(read.body.data.document, payload.document);
  assert.equal(read.body.data.personaConfig.speechTriggerKeywords[0], "new");
  assert.deepEqual((await f.call("", "POST", payload, "create-full")).body, created.body);
  assert.equal((await f.call("", "POST", { ...payload, document: "changed" }, "create-full")).status, 409);
});

test("staged creation recovers after publication failure with the same key", async t => {
  const f = await fixture(t), payload = { roleId: "Recovered", title: "Recovered", document: "# Recovered\nComplete body", config: { custom: "kept" } };
  f.failPublication();
  const failed = await f.call("", "POST", payload, "recover-create");
  assert.equal(failed.status, 500); assert.equal(failed.body.uncertain, true);
  assert.equal((await f.call("/Recovered/document")).body.data.document, payload.document);
  const recovered = await f.call("", "POST", payload, "recover-create");
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  const hash = createHash("sha256").update("recover-create").digest("hex");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, ".role-state/operations", hash + ".json"), "utf8")).state, "committed");
});

test("creation cannot expose a role with only one staged file and retry finishes original staging", async t => {
  const f = await fixture(t), write = fs.writeFile;
  let fail = true;
  const mocked = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    if (fail && String(args[0]).includes(`${path.sep}creating${path.sep}`) && String(args[0]).includes("personaConfig.json")) { fail = false; throw new Error("Disk fixture failure"); }
    return write(...args);
  });
  const payload = { roleId: "Staged", title: "Staged", document: "# Staged\nComplete" };
  const failed = await f.call("", "POST", payload, "stage-key");
  assert.equal(failed.status, 500); assert.equal(failed.body.uncertain, true);
  assert.equal(await fs.stat(path.join(f.root, "Staged")).then(() => true, () => false), false);
  assert.equal((await f.call("")).body.data.roles.some((role: any) => role.roleId === "Staged"), false);
  mocked.mock.restore();
  assert.equal((await f.call("", "POST", payload, "stage-key")).status, 201);
});

test("invalid create input is rejected before receipt or role publication", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("", "POST", { roleId: "Bad", title: "Bad", document: false }, "bad-document")).status, 400);
  assert.equal((await f.call("", "POST", { roleId: "Bad", title: "Bad", config: { automationRules: false } }, "bad-config")).status, 400);
  assert.equal(await fs.stat(path.join(f.root, "Bad")).then(() => true, () => false), false);
  const absent = await f.call("/Absent/document");
  assert.equal(absent.status, 404); assert.equal(absent.body.error, "ROLE_NOT_FOUND");
});

test("creation recovery cannot overwrite edits made after an unconfirmed publication", async t => {
  const f = await fixture(t), payload = { roleId: "Changed", title: "Changed", document: "# Changed\nOriginal" };
  f.failPublication();
  assert.equal((await f.call("", "POST", payload, "changed-create")).status, 500);
  const existing = await f.call("/Changed/document");
  assert.equal((await f.call("/Changed/document", "PUT", { expectedRevision: existing.body.data.revision, document: "# Changed\nNewer" }, "changed-doc")).status, 200);
  const recovered = await f.call("", "POST", payload, "changed-create");
  assert.equal(recovered.status, 503); assert.equal(recovered.body.uncertain, true);
  assert.equal((await f.call("/Changed/document")).body.data.document, "# Changed\nNewer");
});

test("same operation key serializes creation and role commands across roles", async t => {
  for (const scenario of ["create-create", "create-command", "command-command"] as const) {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, "Other"));
    await fs.writeFile(path.join(f.root, "Other/persona.md"), "# Other\n");
    await fs.writeFile(path.join(f.root, "Other/personaConfig.json"), "{}");
    const existing = await f.call("/Existing/configuration"), other = await f.call("/Other/configuration");
    const key = `race-${scenario}`;
    let entered!: () => void, resume!: () => void;
    const firstAtReceipt = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { resume = resolve; });
    const write = fs.writeFile; let held = false;
    const mocked = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
      if (!held && String(args[0]).includes(createHash("sha256").update(key).digest("hex"))) {
        held = true; entered(); await release;
      }
      return write(...args);
    });
    const first = scenario === "command-command"
      ? f.call("/Existing/configuration", "PATCH", { expectedRevision: existing.body.data.revision, config: { custom: "first" } }, key)
      : f.call("", "POST", { roleId: "NewOne", title: "First" }, key);
    const second = () => scenario === "create-create"
      ? f.call("", "POST", { roleId: "NewTwo", title: "Second" }, key)
      : f.call("/Other/configuration", "PATCH", { expectedRevision: other.body.data.revision, config: { custom: "second" } }, key);
    try {
      await firstAtReceipt;
      const blocked = await second();
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal(blocked.body.error, "ROLE_BUSY");
    } finally { resume(); }
    assert.ok([200, 201].includes((await first).status));
    mocked.mock.restore();
    const conflict = await second();
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error, "ROLE_OPERATION_CONFLICT");
    assert.equal((await f.call("/Other/configuration")).body.data.personaConfig.custom, undefined);
    if (scenario === "create-create") await assert.rejects(fs.stat(path.join(f.root, "NewTwo")), { code: "ENOENT" });
  }
});

test("creation rejects a staging junction before writing its contents", async t => {
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), "role-stage-external-"));
  t.after(async () => fs.rm(outside, { recursive: true, force: true }));
  const state = path.join(f.root, ".role-state"); await fs.mkdir(state, { recursive: true });
  try { await fs.symlink(outside, path.join(state, "creating"), "junction"); }
  catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Account cannot create a junction"); return; } throw error; }
  const result = await f.call("", "POST", { roleId: "StageLinked", title: "Stage linked" }, "staging-link");
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error, "ROLE_STAGING_INVALID");
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(fs.stat(path.join(f.root, "StageLinked")), { code: "ENOENT" });
});

test("creation rejects a linked state root before acquiring locks", async t => {
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), "role-state-external-"));
  t.after(async () => fs.rm(outside, { recursive: true, force: true }));
  try { await fs.symlink(outside, path.join(f.root, ".role-state"), "junction"); }
  catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Account cannot create a junction"); return; } throw error; }
  const result = await f.call("", "POST", { roleId: "StateLinked", title: "State linked" }, "state-link");
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error, "ROLE_STAGING_INVALID");
  assert.deepEqual(await fs.readdir(outside), []);
});

test("creation and commands reject linked lock and receipt directories before writing outside", async t => {
  for (const name of ["locks", "operations"]) {
    const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), "role-owned-external-"));
    t.after(async () => fs.rm(outside, { recursive: true, force: true }));
    const original = await f.call("/Existing/configuration");
    const state = path.join(f.root, ".role-state"); await fs.mkdir(state, { recursive: true });
    try { await fs.symlink(outside, path.join(state, name), "junction"); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Account cannot create a junction"); return; } throw error; }
    const create = await f.call("", "POST", { roleId: "NoEscape", title: "No escape" }, `create-${name}`);
    assert.equal(create.status, 403, JSON.stringify(create.body));
    const edit = await f.call("/Existing/configuration", "PATCH", { expectedRevision: original.body.data.revision, config: { custom: "no escape" } }, `edit-${name}`);
    assert.equal(edit.status, 403, JSON.stringify(edit.body));
    assert.deepEqual(await fs.readdir(outside), []);
  }
});

test("operation lock prevents another process from publishing the same key", async t => {
  const f = await fixture(t), key = "cross-process-fixture";
  const lockPath = path.join(f.root, `.operation-${createHash("sha256").update(key).digest("hex")}`);
  const script = `import { withRoleLock } from "./src/roleLifecycle.ts";
await withRoleLock(process.argv[1], async () => {
  process.stdout.write("locked\\n");
  await new Promise(resolve => process.stdin.once("data", resolve));
});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, lockPath], { stdio: ["pipe", "pipe", "pipe"] });
  let errors = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", data => { errors += data; });
  const done = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("exit", code => reject(new Error(`lock process exited early ${code}: ${errors}`)));
      child.once("error", reject);
    });
    const blocked = await f.call("", "POST", { roleId: "CrossProcess", title: "Cross process" }, key);
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, "ROLE_BUSY");
  } finally { child.stdin.end("release\n"); }
  assert.equal(await done, 0, errors);
  const accepted = await f.call("", "POST", { roleId: "CrossProcess", title: "Cross process" }, key);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
});

test("a broken creation staging directory does not block edits to existing roles", async t => {
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), "role-staging-isolation-"));
  t.after(async () => fs.rm(outside, { recursive: true, force: true }));
  const original = await f.call("/Existing/configuration");
  const state = path.join(f.root, ".role-state"); await fs.mkdir(state, { recursive: true });
  try { await fs.symlink(outside, path.join(state, "creating"), "junction"); }
  catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("Account cannot create a junction"); return; } throw error; }
  const updated = await f.call("/Existing/configuration", "PATCH", { expectedRevision: original.body.data.revision, config: { custom: "updated" } }, "existing-update");
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.personaConfig.custom, "updated");
  const creation = await f.call("", "POST", { roleId: "New", title: "New" }, "new-create");
  assert.equal(creation.status, 403, JSON.stringify(creation.body));
  assert.equal(creation.body.error, "ROLE_STAGING_INVALID");
  assert.deepEqual(await fs.readdir(outside), []);
});
