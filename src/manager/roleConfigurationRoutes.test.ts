import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { handleRoleConfigurationApi } from "./roleConfigurationRoutes.js";
import { assertRoleAcceptsWork, beginRoleWork, readRoleMetadata } from "../roleLifecycle.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { installDataMutationAuditSink, type RecordedDataMutationAudit } from "../observability/dataMutationAudit.js";

async function fixture(run: (value: {
  root: string; url: string; routes: GatewayDefinition[]; failPublication: () => void;
  get: (suffix?: string) => Promise<any>; post: (action: string, payload: unknown, key?: string) => Promise<{ response: Response; body: any }>;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-role-lifecycle-"));
  const rolesRoot = path.join(root, "roles");
  await fs.mkdir(path.join(rolesRoot, "Example"), { recursive: true });
  await fs.writeFile(path.join(rolesRoot, "Example", "persona.md"), "# Example role\n");
  await fs.writeFile(path.join(rolesRoot, "Example", "personaConfig.json"), JSON.stringify({ privateExtension: { retained: true }, languageStyle: { styleSkillUrl: "old" } }));
  const routes: GatewayDefinition[] = [];
  let failNext = false;
  const server = http.createServer((request, response) => {
    if (!handleRoleConfigurationApi(request, new URL(request.url!, "http://localhost"), response, {
      rolesRoot, routes: () => routes, assertCatalogReady() {},
      readJson: async <T>(incoming: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
      },
      changed: async () => { if (failNext) { failNext = false; throw new Error("publication interrupted"); } }
    })) { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const get = async (suffix = "/Example/configuration") => {
    const response = await fetch(`${url}/api/roles${suffix}`);
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const post = async (action: string, payload: unknown, key: string = randomUUID()) => {
    const response = await fetch(`${url}/api/roles/Example/${action}`, {
      method: action === "configuration" ? "PUT" : "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(payload)
    });
    return { response, body: await response.json() };
  };
  try { await run({ root, url, routes, get, post, failPublication: () => { failNext = true; } }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
}

test("unbound roles are listed and save without creating a Route; clearing role fields preserves extensions", async () => fixture(async f => {
  const listed = await f.get("");
  assert.equal(listed.roles[0].roleId, "Example");
  const original = await f.get();
  const saved = await f.post("configuration", { expectedRevision: original.revision, config: { recentMessageLimits: { napcat: 9 } } });
  assert.equal(saved.response.status, 200);
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
  assert.equal(rejected.body.error, "ROLE_METHOD_INVALID");
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
