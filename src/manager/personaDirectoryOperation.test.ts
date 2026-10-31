import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { createPersonaDirectoryOperation } from "./personaMessagingRoutes.js";
import { RuntimeRegistry } from "./runtimeRegistry.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { LanAgentAuthority } from "./lanAgentAuthority.js";
import { evaluateLanAgentRequest, assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-directory-operation-"));
  const runtimes = new RuntimeRegistry();
  runtimes.set({ id: "alpha-local", name: "Alpha local", enabled: true, gatewayPort: 0, agentRoleId: "Alpha", agentAdapters: ["codex"] });
  runtimes.set({ id: "beta-local", name: "Beta local", enabled: false, gatewayPort: 0, agentRoleId: "Beta", agentAdapters: ["codex"] });
  runtimes.set({ id: "beta-remote", name: "Beta remote", enabled: true, gatewayPort: 0, agentRoleId: "Beta", agentRoleDeviceId: "fixture-remote", agentAdapters: ["codex"] });
  const presentation = (roleId: string, ownerRoot = root, isPersona = true): RouteCatalogPersonaPresentation => ({ rolesRoot: ownerRoot, roleId, isPersona, displayName: roleId, avatarConfigured: false, files: [], speech: { voiceReady: false } });
  const presentations = [presentation("Alpha"), presentation("Beta"), presentation("Foreign", path.join(root, "other")), presentation("Folder", root, false)];
  const state = { fail: false, revoke: false };
  const authority = new LanAgentAuthority({ statePath: path.join(root, "authority.json") });
  const credential = authority.enroll(authority.issueBootstrapTicket().ticket, "directory-node");
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("persona", [createPersonaDirectoryOperation(() => {
    if (state.fail) throw new Error("Original presentation owner unavailable");
    if (state.revoke) { authority.setNodeEnabled(credential.nodeId, false, true); authority.setNodeEnabled(credential.nodeId, true, false); }
    return { rolesRoot: root, runtimes: () => runtimes.values(), personaPresentations: () => presentations };
  })]);
  const server = http.createServer((request, response) => {
    if (evaluateLanAgentRequest(request, authority, true).kind !== "agent") { response.writeHead(401).end(); return; }
    markAuthenticatedConnectionRequest(request, () => { assertTrustedLanAgentPrincipal(request); });
    if (!registry.handle(request, new URL(request.url!, "http://fixture"), response)) response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await registration.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port;
  const read = (query = "") => fetch(base + "/api/personas" + query, { headers: { authorization: "Bearer " + credential.token }, signal: AbortSignal.timeout(5000) });
  return { state, registry, runtimes, read };
}

test("enabled nodes discover native local-persona reachability without Agent registration or grants", async t => {
  const f = await fixture(t); const response = await f.read(); assert.equal(response.status, 200);
  const rows = (await response.json()).personas;
  assert.deepEqual(rows.map((row: { personaId: string }) => row.personaId), ["Alpha", "Beta"]);
  assert.equal(rows[0].defaultRouteId, "alpha-local"); assert.equal(rows[0].addressable, true);
  assert.equal(rows[1].addressable, false); assert.equal(rows[1].defaultRouteId, undefined);
  assert.deepEqual(rows[1].routes.map((route: { routeId: string }) => route.routeId), ["beta-local"]);
  const operation = f.registry.catalogSnapshot().operations.find(x => x.contract.operationId === "manager.personas.list");
  assert.deepEqual(operation?.contract.aliases, ["agent:GET:/api/personas"]);
});

test("addressable keeps first exact query values and reflects the original runtime registry", async t => {
  const f = await fixture(t);
  const filtered = await (await f.read("?addressable=true&addressable=false&unknown=ignored")).json(); assert.equal(filtered.personas.length, 1);
  for (const query of ["?addressable=TRUE", "?addressable=1", "?addressable=false&addressable=true"]) assert.equal((await (await f.read(query)).json()).personas.length, 2);
  f.runtimes.get("alpha-local")!.definition.enabled = false;
  assert.deepEqual((await (await f.read("?addressable=true")).json()).personas, []);
});

test("original directory failures retain the native error and original-node revocation stops disclosure", async t => {
  const f = await fixture(t); f.state.fail = true;
  const failed = await f.read(); assert.equal(failed.status, 500); assert.match((await failed.json()).message, /Original presentation owner unavailable/);
  f.state.fail = false; f.state.revoke = true;
  const revoked = await f.read(); assert.equal(revoked.status, 403); assert.ok(!(await revoked.text()).includes("alpha-local"));
});
