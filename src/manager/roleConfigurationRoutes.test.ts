import { nativeHttpTestFetch as fetch } from "./nativeHttpTestClient.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createRoleConfigurationOperations } from "./roleConfigurationOperations.js";
import { createRoleConfigurationOwner, type RoleConfigurationContext } from "./roleConfigurationOwner.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { registerLanAgentBodyGuard, assertLanAgentBodyAuthority } from "./lanAgentBodyAuthority.js";
import { Socket } from "node:net";
import { assertRoleAcceptsWork, beginRoleWork, readRoleMetadata, withRoleLock } from "../roleLifecycle.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

async function fixture(run: (value: {
  root: string; url: string; routes: GatewayDefinition[]; failPublication: () => void;
  get: (suffix?: string) => Promise<any>; post: (action: string, payload: unknown, key?: string) => Promise<{ response: Response; body: any }>;
  context: RoleConfigurationContext; identity: { applicationGenerationId: string; managerInstanceId: string };
  switchRoot(): void; revoke(): void; onPublication(action?: () => void): void;
  afterPrepare(action: () => void): void;
  call(suffix: string, method?: string, body?: unknown, key?: string, remote?: boolean): Promise<{ response: Response; body: any }>;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-role-lifecycle-"));
  const rolesRoot = path.join(root, "roles");
  await fs.mkdir(path.join(rolesRoot, "Example"), { recursive: true });
  await fs.writeFile(path.join(rolesRoot, "Example", "persona.md"), "# Example role\n");
  await fs.writeFile(path.join(rolesRoot, "Example", "personaConfig.json"), JSON.stringify({ privateExtension: { retained: true }, languageStyle: { styleSkillUrl: "old" } }));
  const routes: GatewayDefinition[] = [];
  let failNext = false;
  let currentRoot = rolesRoot;
  const identity = { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-manager" };
  let publication: (() => void) | undefined;
  let preparation: (() => void) | undefined;
  const context: RoleConfigurationContext = {
    rolesRoot: () => currentRoot, identity: () => identity, routes: () => routes, assertCatalogReady() {},
    changed: async () => { publication?.(); if (failNext) { failNext = false; throw new Error("publication interrupted"); } }
  };
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("role-configuration-fixture", createRoleConfigurationOperations(context).map(definition => ({
    ...definition, prepare: input => {
      const bound = definition.prepare!(input), action = preparation; preparation = undefined; action?.(); return bound;
    }
  })));
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "empty-node");
  let enabled = true;
  const server = http.createServer((request, response) => {
    if (request.headers.authorization) {
      if (evaluateLanAgentRequest(request, authority, true, () => ({ enabled, incarnation: "fixture-incarnation" })).kind !== "agent") {
        response.writeHead(403).end('{}'); return;
      }
      markAuthenticatedConnectionRequest(request);
      registerLanAgentBodyGuard(request, body => assertLanAgentBodyAuthority(new URL(request.url!, "http://fixture.invalid").pathname, body, undefined));
    }
    if (!registry.handle(request, new URL(request.url!, "http://localhost"), response)) response.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const call = async (suffix: string, method = "GET", body?: unknown, key: string = randomUUID(), remote = true) => {
    const response = await fetch(`${url}/api/roles${suffix}`, { method,
      headers: { "content-type": "application/json", "idempotency-key": key, ...(remote ? { authorization: "Bearer " + credential.token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() };
  };
  const get = async (suffix = "/Example/configuration") => {
    const { response, body } = await call(suffix); assert.equal(response.status, 200, JSON.stringify(body)); return body.data;
  };
  const post = (action: string, payload: unknown, key: string = randomUUID()) =>
    call(`/Example/${action}`, action === "configuration" ? "PUT" : "POST", payload, key);
  try { await run({ root, url, routes, get, post, call, context, identity,
    switchRoot: () => { currentRoot = path.join(root, "replacement"); }, revoke: () => { enabled = false; },
    afterPrepare: action => { preparation = action; },
    onPublication: action => { publication = action; }, failPublication: () => { failNext = true; } }); }
  finally {
    server.closeAllConnections(); await registration.dispose(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("rabi-role-lifecycle-"));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("unbound roles are listed and save without creating a Route; clearing role fields preserves extensions", async () => fixture(async f => {
  const listed = await f.get("");
  assert.equal(listed.roles[0].roleId, "Example");
  const original = await f.get();
  const saved = await f.post("configuration", { expectedRevision: original.revision, config: { recentMessageLimits: { napcat: 9 } } });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.data.config.recentMessageLimits.napcat, 9);
  assert.equal(f.routes.length, 0);
  const persisted = JSON.parse(await fs.readFile(path.join(f.root, "roles/Example/personaConfig.json"), "utf8"));
  assert.deepEqual(persisted.privateExtension, { retained: true });
  assert.equal(persisted.languageStyle, undefined);
  const stale = await f.post("configuration", { expectedRevision: original.revision, config: {} });
  assert.equal(stale.response.status, 412);
}));

test("archive persists, rejects new work and stale saves, while admitted work may finish", async () => fixture(async f => {
  const directory = path.join(f.root, "roles/Example");
  const release = await beginRoleWork(directory);
  const original = await f.get();
  const archive = await f.post("archive", { expectedRevision: original.revision });
  assert.equal(archive.response.status, 200);
  assert.ok((await readRoleMetadata(directory)).archivedAt);
  await assert.rejects(() => assertRoleAcceptsWork(directory), /已归档/);
  assert.equal((await f.get("")).roles.length, 0);
  assert.equal((await f.get("?scope=archived")).roles.length, 1);
  assert.equal((await f.post("configuration", { expectedRevision: original.revision, config: {} })).response.status, 412);
  const busy = await f.post("delete", { expectedRevision: archive.body.data.revision, confirmationId: "Example" });
  assert.equal(busy.body.error, "ROLE_WORK_RUNNING");
  await release();
  const restored = await f.post("restore", { expectedRevision: archive.body.data.revision });
  assert.equal(restored.response.status, 200);
  assert.equal((await readRoleMetadata(directory)).archivedAt, null);
  await assertRoleAcceptsWork(directory);
}));

test("disabled Route references block deletion; successful deletion is replayable and cannot resurrect", async () => fixture(async f => {
  const active = await f.get();
  const archived = await f.post("archive", { expectedRevision: active.revision });
  const payload = { expectedRevision: archived.body.data.revision, confirmationId: "Example" };
  f.routes.push({ id: "disabled", gatewayPort: 0, enabled: false, agentRoleId: "Example" });
  const blocked = await f.post("delete", payload);
  assert.equal(blocked.body.error, "ROLE_REFERENCED");
  assert.match(blocked.body.message, /disabled/);
  f.routes.length = 0;
  const key = randomUUID();
  assert.equal((await f.post("delete", payload, key)).response.status, 200);
  assert.equal((await f.post("delete", payload, key)).response.status, 200);
  await assert.rejects(() => fs.stat(path.join(f.root, "roles/Example")), { code: "ENOENT" });
  await assert.rejects(() => assertRoleAcceptsWork(path.join(f.root, "roles/Example")), /已删除/);
}));

test("same-key recovery confirms a persisted archive after publication interruption", async () => fixture(async f => {
  const original = await f.get();
  const key = randomUUID();
  const payload = { expectedRevision: original.revision };
  f.failPublication();
  assert.equal((await f.post("archive", payload, key)).response.status, 500);
  f.failPublication();
  const stillPending = await f.post("archive", payload, key);
  assert.equal(stillPending.response.status, 500);
  assert.equal(stillPending.body.uncertain, true);
  assert.equal(stillPending.body.mutationOutcome, "unknown");
  const recovered = await f.post("archive", payload, key);
  assert.equal(recovered.response.status, 200);
  assert.ok(recovered.body.data.archivedAt);
  const changedPayload = await f.post("restore", { expectedRevision: recovered.body.data.revision }, key);
  assert.equal(changedPayload.body.error, "ROLE_OPERATION_CONFLICT");
}));

test("damaged metadata stays an error and cannot be selected or archived", async () => fixture(async f => {
  await fs.writeFile(path.join(f.root, "roles/Example/roleMetadata.json"), "{broken");
  const list = await f.get("");
  assert.ok(list.roles[0].error);
  await assert.rejects(() => assertRoleAcceptsWork(path.join(f.root, "roles/Example")), /无法读取/);
}));

test("reference queries reject mutation methods without restoring archived roles", async () => fixture(async f => {
  const original = await f.get();
  const archived = await f.post("archive", { expectedRevision: original.revision });
  const rejected = await f.post("references", { expectedRevision: archived.body.data.revision });
  assert.equal(rejected.response.status, 405);
  assert.equal((await f.get()).archivedAt, archived.body.data.archivedAt);
}));

test("role file publication emits audit evidence without configuration contents", async () => fixture(async f => {
  const records: RecordedDataMutationAudit[] = [];
  const release = installDataMutationAuditSink(record => records.push(record));
  try {
    const original = await f.get();
    await f.post("configuration", { expectedRevision: original.revision, config: { speechTriggerKeywords: ["private-fixture-content"] } });
    assert.ok(records.some(record => record.event === "role_file_committed" && record.target.id === "personaConfig.json"));
    assert.doesNotMatch(JSON.stringify(records), /private-fixture-content/);
  } finally { release(); }
}));

test("all eight registrations serve authenticated empty bindings and the same local role owner", async () => fixture(async f => {
  const definitions = createRoleConfigurationOperations(f.context);
  assert.equal(definitions.length, 8);
  assert.ok(definitions.every(definition => definition.prepare && definition.contract.exposure === "public"));
  assert.equal((await f.call("/Example/configuration", "GET", undefined, undefined, false)).response.status, 200);
  const created = await f.call("", "POST", { roleId: "新角色", title: "New role\nTitle" });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.roleId, "新角色");
  assert.equal(await fs.readFile(path.join(f.root, "roles/新角色/persona.md"), "utf8"), "# New role Title\n");
  assert.equal((await f.call("/新角色/references")).body.data.runningWork, 0);
  assert.equal(f.routes.length, 0);
}));

test("prepared functional owner captures the role root before body consumption", async () => fixture(async f => {
  const original = await f.get();
  const definitions = createRoleConfigurationOperations(f.context);
  const definition = definitions.find(item => item.contract.operationId === "manager.roles.config")!;
  const request = new http.IncomingMessage(new Socket()); request.method = "PUT";
  const input = { request, response: {} as http.ServerResponse, url: new URL("http://fixture.invalid/api/roles/Example/configuration"), path: { roleId: "Example" }, query: {} };
  const prepared = await definition.prepare!(input);
  assert.equal(typeof prepared, "function");
  f.switchRoot();
  const result = await (prepared as typeof definition.handler)({ ...input, body: { expectedRevision: original.revision, config: {} } });
  assert.equal(result.status, 409);
  assert.equal((result.body as any).mutationOutcome, "not_started");
  assert.equal((result.body as any).data, undefined);
  assert.equal(await fs.stat(path.join(f.root, "roles/Example/personaConfig.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(f.root, "replacement")).then(() => true, () => false), false);
}));

for (const boundary of ["root", "generation", "connection"] as const) {
  test(`real HTTP ${boundary} change between prepare and body consumption prevents writes`, async () => fixture(async f => {
    const original = await f.get(), file = path.join(f.root, "roles/Example/personaConfig.json");
    const before = await fs.readFile(file, "utf8");
    f.afterPrepare(() => {
      if (boundary === "root") f.switchRoot();
      else if (boundary === "generation") f.identity.applicationGenerationId = "replacement-generation";
      else f.revoke();
    });
    const result = await f.post("configuration", { expectedRevision: original.revision, config: {} });
    assert.equal(result.response.status, boundary === "connection" ? 403 : 409, JSON.stringify(result.body));
    assert.equal(result.body.data, undefined);
    assert.equal(result.body.uncertain, undefined);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.equal(await fs.stat(path.join(f.root, "roles/.role-state/operations")).then(() => true, () => false), false);
  }));
}

test("native role lock conflict leaves configuration unchanged and releases only its own lease", async () => fixture(async f => {
  const original = await f.get();
  await withRoleLock(path.join(f.root, "roles/Example"), async () => {
    const result = await f.post("configuration", { expectedRevision: original.revision, config: {} });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error, "ROLE_BUSY");
    assert.equal(result.body.mutationOutcome, "not_started");
    assert.equal((await f.get()).revision, original.revision);
  });
  assert.equal((await f.post("configuration", { expectedRevision: original.revision, config: {} })).response.status, 200);
}));

test("prepared owner rejects generation changes, cancellation and explicit read-only mode before business writes", async () => fixture(async f => {
  const original = await f.get(), request = new http.IncomingMessage(new Socket()); request.method = "PUT";
  const owner = createRoleConfigurationOwner(f.context);
  const changed = owner.prepare(request);
  f.identity.managerInstanceId = "replacement-manager";
  await assert.rejects(() => changed.command("Example", "config", { expectedRevision: original.revision, config: {} }, randomUUID()), (error: any) => error.statusCode === 409);
  assert.equal(changed.mutationOutcome(), "not_started");
  const controller = new AbortController(), cancelled = owner.prepare(request, controller.signal);
  controller.abort(new Error("Controlled cancellation"));
  await assert.rejects(() => cancelled.command("Example", "config", { expectedRevision: original.revision }, randomUUID()), /Controlled cancellation/);
  f.context.isReadOnly = () => true;
  assert.throws(() => owner.prepare(request), (error: any) => error.code === "ROLE_READ_ONLY");
  assert.equal((await f.get()).revision, original.revision);
}));

for (const boundary of ["generation", "root", "connection"] as const) {
  test(`real HTTP ${boundary} change after archive write withholds disclosure and retains the pending native receipt`, async () => fixture(async f => {
    const original = await f.get(), key = randomUUID(), payload = { expectedRevision: original.revision };
    f.onPublication(() => {
      if (boundary === "generation") f.identity.applicationGenerationId = "replacement-generation";
      else if (boundary === "root") f.switchRoot();
      else f.revoke();
    });
    const result = await f.post("archive", payload, key);
    assert.equal(result.response.status, boundary === "connection" ? 403 : 409, JSON.stringify(result.body));
    assert.equal(result.body.uncertain, true);
    assert.equal(result.body.mutationOutcome, "unknown");
    assert.equal(result.body.data, undefined);
    assert.ok((await readRoleMetadata(path.join(f.root, "roles/Example"))).archivedAt);
    const receipts = await fs.readdir(path.join(f.root, "roles/.role-state/operations"));
    assert.equal(receipts.length, 1);
    const receipt = JSON.parse(await fs.readFile(path.join(f.root, "roles/.role-state/operations", receipts[0]), "utf8"));
    assert.equal(receipt.state, "pending");
  }));
}

test("multi-file role creation with a publication failure remains uncertain", async () => fixture(async f => {
  f.failPublication();
  const result = await f.call("", "POST", { roleId: "Partial", title: "Partial fixture" });
  assert.equal(result.response.status, 500);
  assert.equal(result.body.uncertain, true);
  assert.equal(result.body.data, undefined);
  assert.equal(await fs.readFile(path.join(f.root, "roles/Partial/persona.md"), "utf8"), "# Partial fixture\n");
  const inspected = await f.call("/Partial/configuration");
  assert.equal(inspected.response.status, 200);
  const repeated = await f.call("", "POST", { roleId: "Partial", title: "Partial fixture" });
  assert.equal(repeated.response.status, 500);
}));

test("a persisted pending receipt followed by generation change stops the configuration write and recovers only with the original payload", async () => fixture(async f => {
  const original = await f.get(), key = randomUUID(), file = path.join(f.root, "roles/Example/personaConfig.json");
  const before = await fs.readFile(file, "utf8"), receiptName = createHash("sha256").update(key).digest("hex") + ".json";
  const payload = { expectedRevision: original.revision, config: { speechTriggerKeywords: ["pending-fixture"] } };
  let interrupted = false;
  const release = installDataMutationAuditSink(record => {
    if (!interrupted && record.event === "role_file_committed" && record.target.id === receiptName) {
      interrupted = true; f.identity.applicationGenerationId = "replacement-generation";
    }
  });
  try {
    const failed = await f.post("configuration", payload, key);
    assert.equal(failed.response.status, 409);
    assert.equal(failed.body.uncertain, true);
    assert.equal(failed.body.data, undefined);
    assert.equal(await fs.readFile(file, "utf8"), before);
    const receipt = JSON.parse(await fs.readFile(path.join(f.root, "roles/.role-state/operations", receiptName), "utf8"));
    assert.equal(receipt.state, "pending");
    const recovered = await f.post("configuration", payload, key);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(recovered.body.data.config.speechTriggerKeywords, ["pending-fixture"]);
    assert.equal((await f.post("configuration", { ...payload, config: {} }, key)).body.error, "ROLE_OPERATION_CONFLICT");
  } finally { release(); }
}));

test("role automation references and recursive links block native deletion without removing the role", async () => fixture(async f => {
  const directory = path.join(f.root, "roles/Example"), original = await f.get();
  const archived = await f.post("archive", { expectedRevision: original.revision });
  const payload = { expectedRevision: archived.body.data.revision, confirmationId: "Example" };
  await fs.mkdir(path.join(f.root, "roles/Other"));
  await fs.writeFile(path.join(f.root, "roles/Other/personaConfig.json"), JSON.stringify({ automationRules: [{ targetRoleId: "Example" }] }));
  assert.equal((await f.post("delete", payload)).body.error, "ROLE_REFERENCED");
  await fs.writeFile(path.join(f.root, "roles/Other/personaConfig.json"), "{}");
  const external = path.join(f.root, "outside"); await fs.mkdir(external);
  await fs.writeFile(path.join(external, "retained.txt"), "retained fixture");
  await fs.symlink(external, path.join(directory, "link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.post("delete", payload)).body.error, "ROLE_LINK_PRESENT");
  assert.equal(await fs.readFile(path.join(external, "retained.txt"), "utf8"), "retained fixture");
}));

for (const boundary of ["generation", "root", "connection"] as const) {
  test(`async changed callback retains original ${boundary} assertion after refresh and prevents stale publication`, async () => fixture(async f => {
    const original = await f.get(), key = randomUUID();
    let events = 0, refreshes = 0;
    f.context.changed = async (roleId, assertCurrent) => {
      assert.equal(roleId, "Example");
      assert.equal(typeof assertCurrent, "function");
      assertCurrent();
      await Promise.resolve();
      refreshes++;
      if (boundary === "generation") f.identity.applicationGenerationId = "replacement-generation";
      else if (boundary === "root") f.switchRoot();
      else f.revoke();
      assertCurrent();
      events++;
      assertCurrent();
    };
    const result = await f.post("configuration", { expectedRevision: original.revision, config: { speechTriggerKeywords: ["committed-before-refresh"] } }, key);
    assert.equal(result.response.status, boundary === "connection" ? 403 : 409);
    assert.equal(refreshes, 1);
    assert.equal(events, 0);
    assert.equal(result.body.uncertain, true);
    assert.equal(result.body.data, undefined);
    const persisted = JSON.parse(await fs.readFile(path.join(f.root, "roles/Example/personaConfig.json"), "utf8"));
    assert.deepEqual(persisted.speechTriggerKeywords, ["committed-before-refresh"]);
    assert.deepEqual(persisted.privateExtension, { retained: true });
    const receiptFile = createHash("sha256").update(key).digest("hex") + ".json";
    const receipt = JSON.parse(await fs.readFile(path.join(f.root, "roles/.role-state/operations", receiptFile), "utf8"));
    assert.equal(receipt.state, "pending");
  }));
}

test("normal command, pending receipt replay and create pass their exact prepared assertion into changed", async () => fixture(async f => {
  const original = await f.get(), owner = createRoleConfigurationOwner(f.context), key = randomUUID();
  let expectedAssertion: () => void, publications = 0, failOnce = true;
  f.context.changed = async (_roleId, assertCurrent) => {
    assert.strictEqual(assertCurrent, expectedAssertion);
    assertCurrent();
    await Promise.resolve();
    assert.strictEqual(assertCurrent, expectedAssertion);
    assertCurrent();
    publications++;
    if (failOnce) { failOnce = false; throw new Error("Controlled first publication failure"); }
  };
  const request = new http.IncomingMessage(new Socket()); request.method = "PUT";
  const first = owner.prepare(request); expectedAssertion = first.assertCurrent;
  const payload = { expectedRevision: original.revision, config: { speechTriggerKeywords: ["original-request"] } };
  await assert.rejects(() => first.command("Example", "config", payload, key), /Controlled first publication failure/);
  const replay = owner.prepare(request); expectedAssertion = replay.assertCurrent;
  await replay.command("Example", "config", payload, key);
  const createRequest = new http.IncomingMessage(new Socket()); createRequest.method = "POST";
  const creation = owner.prepare(createRequest); expectedAssertion = creation.assertCurrent;
  await creation.create({ expectedRevision: "", roleId: "Created", title: "Created fixture" });
  assert.equal(publications, 3);
}));

test("real HTTP missing native role detail is 404 for authenticated empty-node and local consumers without creating a role", async () => fixture(async f => {
  const existing = await f.get(), file = path.join(f.root, "roles/Example/personaConfig.json");
  const before = await fs.readFile(file, "utf8");
  for (const remote of [true, false]) {
    const result = await f.call("/AbsentCompiledRole/configuration", "GET", undefined, undefined, remote);
    assert.equal(result.response.status, 404, JSON.stringify(result.body));
    assert.equal(result.body.error, "ROLE_NOT_FOUND");
    assert.equal(result.body.mutationOutcome, "not_started");
    assert.equal(result.body.uncertain, undefined);
    assert.equal(result.body.data, undefined);
  }
  assert.equal((await f.get()).revision, existing.revision);
  assert.equal(await fs.readFile(file, "utf8"), before);
  assert.deepEqual(await fs.readdir(path.join(f.root, "roles")), ["Example"]);
}));

test("unavailable role storage and damaged native role configuration retain operational failures instead of becoming role-not-found", async () => fixture(async f => {
  const originalRoot = f.context.rolesRoot;
  f.context.rolesRoot = () => path.join(f.root, "UnavailableRoleStorage");
  const unavailable = await f.call("/AbsentCompiledRole/configuration");
  assert.equal(unavailable.response.status, 500);
  assert.equal(unavailable.body.error, "ROLE_OPERATION_FAILED");
  f.context.rolesRoot = originalRoot;
  await fs.writeFile(path.join(f.root, "roles/Example/personaConfig.json"), "{broken");
  const damaged = await f.call("/Example/configuration");
  assert.equal(damaged.response.status, 500);
  assert.equal(damaged.body.error, "ROLE_OPERATION_FAILED");
  await fs.writeFile(path.join(f.root, "roles/Example/personaConfig.json"), "{}");
  await fs.writeFile(path.join(f.root, "roles/Example/roleMetadata.json"), "{broken");
  const metadata = await f.call("/Example/configuration");
  assert.equal(metadata.response.status, 503);
  assert.equal(metadata.body.error, "ROLE_METADATA_UNAVAILABLE");
}));
