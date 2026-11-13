import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRoleConfigurationOperations } from "./roleConfigurationOperations.js";
import { ManagerPluginRouteRegistry } from "../../../../manager/managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "../../../../manager/connectionRequestAccess.js";

const rule = (id: string) => ({ id, name: id, enabled: true,
  trigger: { type: "message", triggerIds: ["private_message"] },
  action: { type: "deliver_agent", target: { kind: "recipient", recipientId: "primary" }, template: "Original template\nwith a newline" }
});

async function fixture(t: test.TestContext, configuration: Record<string, unknown> = { automationRules: [rule("first"), rule("last")] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "role-automation-http-")), roleDir = path.join(root, "Example");
  await fs.mkdir(roleDir); await fs.writeFile(path.join(roleDir, "persona.md"), "# Example\n");
  const file = path.join(roleDir, "personaConfig.json");
  await fs.writeFile(file, JSON.stringify({ extension: { retained: true }, languageStyle: { styleSkillUrl: "local-style" }, ...configuration }));
  let fail = false, readOnly = false;
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("role-automation-fixture", createRoleConfigurationOperations({
    rolesRoot: () => root, identity: () => ({ applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" }),
    routes: () => [], assertCatalogReady() {}, isReadOnly: () => readOnly,
    changed: async (_id, check) => { check(); if (fail) { fail = false; throw new Error("publication interrupted"); } }
  }));
  const server = http.createServer((request, response) => {
    Object.defineProperty(request.socket, "remoteAddress", { value: "192.0.2.45", configurable: true });
    markAuthenticatedConnectionRequest(request);
    if (!registry.handle(request, new URL(request.url!, "http://fixture.invalid"), response)) response.writeHead(404).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  t.after(async () => {
    server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("role-automation-http-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const call = async (suffix = "", method = "GET", body?: unknown, key = randomUUID()) => {
    const response = await fetch(base + "/api/roles/Example/automation-rules" + suffix, { method,
      headers: { "content-type": "application/json", "idempotency-key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const revision = async () => { const result = await call(); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data.revision as string; };
  return { call, revision, file, root, failNext: () => { fail = true; }, readOnly: () => { readOnly = true; } };
}

test("authenticated Agent lists, searches and reads the same message/schedule rules without a Route binding", async t => {
  const f = await fixture(t);
  const list = await f.call(); assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.data.rules.map((item: any) => item.id), ["first", "last"]);
  const filtered = await f.call("?query=FIRST&enabled=true"); assert.equal(filtered.body.data.rules.length, 1);
  assert.equal((await f.call("/first")).body.data.rule.action.template, "Original template\nwith a newline");
  assert.equal((await f.call("/absent")).status, 404);
});

test("item create/patch/delete preserve neighbours and unrelated configuration; committed retries retain their original result", async t => {
  const f = await fixture(t), key = randomUUID(), expectedRevision = await f.revision();
  const request = { expectedRevision, rule: { ...rule("created"), id: undefined } };
  const created = await f.call("", "POST", request, key); assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.rule.id;
  assert.match(id, /^automation-/); assert.equal(created.body.state, "committed");
  const updated = await f.call("/" + id, "PATCH", { expectedRevision: await f.revision(), patch: { name: "Changed", action: { template: "New\ntext" } } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.rule.action.target.recipientId, "primary");
  assert.equal(updated.body.data.rule.action.template, "New\ntext");
  const retry = await f.call("", "POST", request, key); assert.equal(retry.status, 201); assert.deepEqual(retry.body, created.body);
  assert.equal((await f.call("/" + id)).body.data.rule.name, "Changed");
  const deleteBody = { expectedRevision: await f.revision() }, deleteKey = randomUUID();
  const deleted = await f.call("/" + id, "DELETE", deleteBody, deleteKey); assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual((await f.call("/" + id, "DELETE", deleteBody, deleteKey)).body, deleted.body);
  assert.equal((await f.call("/" + id)).status, 404);
  const config = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.deepEqual(config.automationRules.map((item: any) => item.id), ["first", "last"]);
  assert.deepEqual(config.extension, { retained: true }); assert.equal(config.languageStyle.styleSkillUrl, "local-style");
});

test("delete leaves an explicit empty array, including the default panel rule", async t => {
  const f = await fixture(t, { automationRules: [rule("role-panel-message")] });
  assert.equal((await f.call("/role-panel-message", "DELETE", { expectedRevision: await f.revision() })).status, 200);
  assert.deepEqual((await f.call()).body.data.rules, []);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")).automationRules, []);
});

test("a newly created rule retains the existing panel rule's trailing position", async t => {
  const f = await fixture(t, { automationRules: [rule("first"), rule("role-panel-message")] });
  assert.equal((await f.call("", "POST", { expectedRevision: await f.revision(), rule: rule("new-rule") })).status, 201);
  assert.deepEqual((await f.call()).body.data.rules.map((value: any) => value.id), ["first", "new-rule", "role-panel-message"]);
});

test("one malformed stored rule does not hide healthy neighbours or pretend to be absent", async t => {
  const bad = { ...rule("broken"), action: { type: "deliver_agent", target: { kind: "missing" } } };
  const f = await fixture(t, { automationRules: [rule("first"), bad, rule("last")] });
  const result = await f.call(); assert.equal(result.status, 200);
  assert.deepEqual(result.body.data.rules.map((value: any) => value.id), ["first", "last"]);
  assert.equal(result.body.data.warnings[0].ruleId, "broken");
  assert.equal((await f.call("/last")).status, 200); assert.equal((await f.call("/broken")).status, 409);
});

test("null and unknown stored rule types stay unchanged while normal items remain editable", async t => {
  const invalid = { ...rule("unknown"), trigger: { type: "unsupported" } };
  const invalidId = { ...rule("invalid-id"), id: 123 };
  const f = await fixture(t, { automationRules: [rule("first"), null, invalid, invalidId, rule("last")] });
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.rules.map((value: any) => value.id), ["first", "last"]);
  assert.equal(response.body.data.warnings.length, 3);
  assert.equal(response.body.data.warnings[0].index, 1); assert.equal(response.body.data.warnings[0].ruleId, undefined);
  const write = await f.call("/first", "PATCH", { expectedRevision: response.body.data.revision, patch: { name: "Edited normally" } });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.equal(saved.automationRules[0].name, "Edited normally");
  assert.equal(saved.automationRules[1], null); assert.deepEqual(saved.automationRules[2], invalid);
  assert.deepEqual(saved.automationRules[3], invalidId);
  assert.equal((await f.call("/last")).status, 200);
});

test("same original item request recovers after publication fails without recomputing a newer request fingerprint", async t => {
  const f = await fixture(t), key = randomUUID();
  const request = { expectedRevision: await f.revision(), rule: rule("recovered") };
  f.failNext(); const failed = await f.call("", "POST", request, key);
  assert.equal(failed.status, 500); assert.equal(failed.body.uncertain, true);
  const recovered = await f.call("", "POST", request, key); assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal((await f.call()).body.data.rules.filter((item: any) => item.id === "recovered").length, 1);
  assert.equal((await f.call("", "POST", { ...request, rule: rule("another") }, key)).status, 409);
});

test("stale and concurrent item edits cannot overwrite other saves", async t => {
  const f = await fixture(t), expectedRevision = await f.revision();
  const results = await Promise.all([
    f.call("/first", "PATCH", { expectedRevision, patch: { name: "Winner" } }),
    f.call("/last", "PATCH", { expectedRevision, patch: { name: "Other" } })
  ]);
  const statuses = results.map(result => result.status).sort();
  assert.equal(statuses[0], 200);
  assert.ok(statuses[1] === 409 || statuses[1] === 412, "The original role lock or CAS must reject the other writer.");
  assert.equal((await f.call("/first", "DELETE", { expectedRevision })).status, 412);
});

test("invalid new rules are rejected before mutation and normal rules remain readable", async t => {
  const f = await fixture(t), expectedRevision = await f.revision(), original = await fs.readFile(f.file, "utf8");
  const invalidRules = [
    rule("   "),
    { ...rule("bad"), trigger: { type: "message", regex: "[" } },
    { ...rule("bad"), trigger: { type: "schedule", schedule: {} } },
    { ...rule("bad"), trigger: { type: "schedule", schedule: { type: "daily_time", timeOfDay: "29:91" } } },
    { ...rule("bad"), action: { type: "deliver_agent" } },
    { ...rule("bad"), action: { type: "deliver_agent", target: { kind: "missing" } } },
    { ...rule("bad"), action: { type: "deliver_agent", target: { kind: "session", agentAdapter: "codex" } } },
    { ...rule("bad"), action: { type: "run_script", scriptPath: "" } }
  ];
  for (const invalid of invalidRules) assert.equal((await f.call("", "POST", { expectedRevision, rule: invalid })).status, 400, JSON.stringify(invalid));
  assert.equal(await fs.readFile(f.file, "utf8"), original);
  assert.equal((await f.call()).body.data.rules.length, 2);
  assert.equal((await f.call("/first", "PATCH", { expectedRevision, patch: { id: "new-id" } })).status, 400);
});

test("existing long rule IDs remain manageable and new IDs use the native trim behavior", async t => {
  const id = "historical-" + "x".repeat(160), f = await fixture(t, { automationRules: [rule(id)] });
  assert.equal((await f.call('/' + id)).status, 200);
  assert.equal((await f.call('/' + id, 'PATCH', { expectedRevision: await f.revision(), patch: { name: 'Still editable' } })).status, 200);
  assert.equal((await f.call('/' + id, 'DELETE', { expectedRevision: await f.revision() })).status, 200);
  const created = await f.call('', 'POST', { expectedRevision: await f.revision(), rule: rule('  trimmed  ') });
  assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.data.rule.id, 'trimmed');
});

test("schedule and script actions are saved without invoking the script, and explicit read-only mode rejects writes", async t => {
  const f = await fixture(t);
  const result = await f.call("", "POST", { expectedRevision: await f.revision(), rule: {
    id: "scheduled-script", trigger: { type: "schedule", schedule: { id: "daily", type: "daily_time", timeOfDay: "09:00" } },
    action: { type: "run_script", scriptPath: "C:/missing/never-executed.ps1", arguments: ["--fixture"] }
  } });
  assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.data.rule.trigger.schedule.timeOfDay, "09:00");
  const patched = await f.call("/scheduled-script", "PATCH", { expectedRevision: await f.revision(), patch: { trigger: { schedule: { timeOfDay: "10:00" } } } });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.data.rule.trigger.schedule.type, "daily_time"); assert.equal(patched.body.data.rule.trigger.schedule.timeOfDay, "10:00");
  const revision = await f.revision(); f.readOnly();
  assert.equal((await f.call("/scheduled-script", "DELETE", { expectedRevision: revision })).status, 403);
  assert.equal((await f.call()).status, 200);
});


test("daily multi-time rules retain all configured times and reject invalid times", async t => {
  const f = await fixture(t);
  const expectedRevision = await f.revision();
  const scheduled = { ...rule("daily-multiple"), trigger: { type: "schedule", schedule: { id: "daily", type: "daily_time", timeOfDays: ["10:00", "14:30"] } } };
  const created = await f.call("", "POST", { expectedRevision, rule: scheduled });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const read = await f.call("/daily-multiple");
  assert.deepEqual(read.body.data.rule.trigger.schedule.timeOfDays, ["10:00", "14:30"]);
  const nextRevision = await f.revision();
  const invalid = await f.call("/daily-multiple", "PATCH", { expectedRevision: nextRevision, patch: { trigger: { type: "schedule", schedule: { type: "daily_time", timeOfDays: ["99:00"] } } } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  const unchanged = await f.call("/daily-multiple");
  assert.deepEqual(unchanged.body.data.rule.trigger.schedule.timeOfDays, ["10:00", "14:30"]);
});
