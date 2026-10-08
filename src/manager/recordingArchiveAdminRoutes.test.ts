import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { RecordingArchiveBindings, archiveAdminDigest, archiveSettingsEtag } from "./recordingArchiveBindings.js";
import { recordingArchiveAdminHandler } from "./recordingArchiveAdminRoutes.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";

test("administrative settings enforce preconditions, persist replay, and never expose paths", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-admin-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const role = path.join(dir, "roles", "test-role"); await fs.mkdir(path.join(role, "all-day-recording"), { recursive: true });
  const state = path.join(dir, "state"); await fs.mkdir(state);
  class LostResponseBindings extends RecordingArchiveBindings {
    override async configureAdministrative(...args: Parameters<RecordingArchiveBindings["configureAdministrative"]>): ReturnType<RecordingArchiveBindings["configureAdministrative"]> {
      await super.configureAdministrative(...args);
      throw new Error("simulated failure after atomic config commit");
    }
  }
  const bindings = new LostResponseBindings(state, () => role);
  const options = { bindings, receiptRoot: state, identity: () => ({ applicationGenerationId: "gen", managerInstanceId: "instance" }), workerId: () => "pc-test", readOnly: () => false };
  let handler = recordingArchiveAdminHandler(options);
  let verifiedConnection = false;
  const server = http.createServer((req, res) => {
    if (verifiedConnection) markAuthenticatedConnectionRequest(req);
    handler(req, new URL(req.url!, "http://localhost"), res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/resource-cache/archive-settings`;
  const first = await fetch(url), etag = first.headers.get("etag")!;
  assert.equal(first.status, 200); assert.ok(!(await first.text()).includes(dir));
  const input = { owner: "phone-test", roleId: "test-role", storageNamespaceId: "11111111-2222-3333-4444-555555555555", provision: true, enabled: true, expectedRevision: 0 };
  const headers = { "content-type": "application/json", "if-match": etag, "idempotency-key": "operation-1", "x-rabiroute-expected-application-generation-id": "gen", "x-rabiroute-expected-manager-instance-id": "instance" };
  const put = (extra = {}, body = input) => fetch(url, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await put({ "x-rabilink-tunnel-local": "gen" })).status, 403);
  assert.equal((await put({ origin: "http://other.invalid" })).status, 403);
  verifiedConnection = true;
  const authenticated = await fetch(url, { headers: { "x-rabilink-tunnel-local": "gen" } });
  assert.equal(authenticated.status, 200);
  verifiedConnection = false;
  assert.equal((await put({ "x-rabiroute-expected-manager-instance-id": "old" })).status, 409);
  assert.equal((await put({ "if-match": "W/\"old\"" })).status, 400);
  assert.equal((await put({ "if-match": "\"stale\"", "idempotency-key": "stale-op" })).status, 412);
  await assert.rejects(fs.access(path.join(role, "all-day-recording", "media-archive")));
  const success = await put(); assert.equal(success.status, 200); const successTag = success.headers.get("etag");
  assert.equal(success.headers.get("idempotency-key"), "operation-1");
  handler = recordingArchiveAdminHandler({ ...options, bindings: new RecordingArchiveBindings(state, () => role) });
  const replay = await put(); assert.equal(replay.status, 200); assert.equal(replay.headers.get("etag"), successTag);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal((await put({}, { ...input, enabled: false })).status, 409);
  const recovered = await bindings.recoverAdministrative("operation-1", archiveAdminDigest(input, etag));
  assert.equal(recovered?.etag, successTag);
  assert.equal(await bindings.recoverAdministrative("other-op", archiveAdminDigest(input, etag)), null);
  let provisionCalls = 0;
  class PartialBindings extends RecordingArchiveBindings {
    override async provisionNamespace(roleId: string, ns: string): ReturnType<RecordingArchiveBindings["provisionNamespace"]> {
      provisionCalls++;
      await super.provisionNamespace(roleId, ns);
      throw new Error("simulated failure after namespace commit");
    }
  }
  handler = recordingArchiveAdminHandler({ ...options, bindings: new PartialBindings(state, () => role) });
  const partialInput = { ...input, owner: "second-phone" };
  const partialHeaders = { "if-match": successTag!, "idempotency-key": "partial-op" };
  assert.equal((await put(partialHeaders, partialInput)).status, 503);
  assert.equal((await put(partialHeaders, partialInput)).status, 503);
  assert.equal(provisionCalls, 1, "uncertain retry must only read operation stamp, not provision again");
  assert.equal(await bindings.lookupOwner("second-phone"), null);
});

test("provision-only failure stays uncertain; exact atomic stamp is necessary", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "archive-admin-partial-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const role = path.join(dir, "role"); await fs.mkdir(path.join(role, "all-day-recording"), { recursive: true });
  const bindings = new RecordingArchiveBindings(dir, () => role);
  const input = { owner: "phone", roleId: "role", storageNamespaceId: "11111111-2222-3333-4444-555555555555", provision: true, enabled: true, expectedRevision: 0 };
  const etag = archiveSettingsEtag(await bindings.listBindings());
  await bindings.provisionNamespace(input.roleId, input.storageNamespaceId);
  assert.equal(await bindings.recoverAdministrative("op", archiveAdminDigest(input, etag)), null);
  await fs.writeFile(path.join(dir, "resource-cache.json"), JSON.stringify({ directory: "retained", archiveBindings: { schemaVersion: 1, revision: 0, ownerRoleBindings: {} } }));
  await bindings.configureAdministrative(input, etag, "op");
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "resource-cache.json"), "utf8")).directory, "retained");
  assert.ok(await bindings.recoverAdministrative("op", archiveAdminDigest(input, etag)));
});
