import test from "node:test";
import { spawnSync } from "node:child_process";
import { readPersonaReadSettings } from "../shared/personaReadSettings.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { readPersonaReferenceSnapshot, resolveRemotePersonaSnapshot, validateRemotePersonaLanguageStyle, createPersonaBootstrapOperation, handleRemotePersonaResolutionApi } from "./remotePersonaRoutes.js";
import { createPersonaResourceOperations } from "./personaResourceOperations.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { TunnelDenied } from "../peerTunnel/security.js";
import { ROLE_CONTEXT_ROUTE_HEADER, ROLE_CONTEXT_CAPABILITY_HEADER, ROLE_CONTEXT_GENERATION_HEADER, ROLE_CONTEXT_MANAGER_HEADER } from "./roleContextProjection.js";
import { LanguageStyleValidator } from "../languageStyleValidation.js";

const local = { applicationGenerationId: "local-generation", managerInstanceId: "local-instance" };
const remote = { applicationGenerationId: "remote-generation", managerInstanceId: "remote-instance" };
const meta = { ...remote, health: { live: true, requiredReady: true, state: "degraded" } };
const snapshot = { ...remote, schemaVersion: 1, roleId: "Example", file: "persona.md", document: "# Remote Example", personaConfig: { recentMessageLimits: { napcat: 7 } }, revision: "a".repeat(64) };
const definition = { id: "route-a", name: "Route A", gatewayPort: 0, agentRoleDeviceId: "peer-b", agentRoleId: "Example", agentRoleFile: "persona.md" };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function reader(overrides: Partial<Parameters<typeof resolveRemotePersonaSnapshot>[1]> = {}) {
  return { identity: () => local, managerBaseUrl: "http://127.0.0.1:51111", remoteGeneration: async () => remote.applicationGenerationId,
    fetchRemote: async (_device: string, pathname: string) => pathname === "/meta" ? reply(meta) : reply({ code: 0, data: snapshot }), ...overrides };
}

test("remote snapshot keeps the selected owner and dynamic knowledge prefix", async () => {
  const paths: string[] = [];
  const data = await resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (device, pathname, init) => {
    assert.equal(device, "peer-b"); assert.equal(init.method, "GET"); paths.push(pathname);
    return pathname === "/meta" ? reply(meta) : reply({ code: 0, data: snapshot });
  } }));
  assert.deepEqual(paths, ["/meta", "/api/roles/Example/persona-reference?file=persona.md", "/meta"]);
  assert.equal(data.knowledgeApiBaseUrl, "http://127.0.0.1:51111/api/rabilink/peer/http/peer-b/persona");
  assert.equal(data.applicationGenerationId, local.applicationGenerationId);
  assert.equal(data.remoteApplicationGenerationId, remote.applicationGenerationId);
  assert.equal(data.personaConfig.recentMessageLimits?.napcat, 7);
});
test("remote snapshot fails closed for untrusted, old or changed owners", async () => {
  await assert.rejects(resolveRemotePersonaSnapshot(definition, reader({ remoteGeneration: async () => { throw new Error("peer_device_not_trusted"); } })), /peer_device_not_trusted/);
  await assert.rejects(resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (_id, pathname) => pathname === "/meta" ? reply(meta) : reply({}, 404) })), /升级/);
  await assert.rejects(resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (_id, pathname) => pathname === "/meta" ? reply(meta) : reply({ error: "PERSONA_FILE_NOT_FOUND" }, 404) })), /不存在/);
  await assert.rejects(resolveRemotePersonaSnapshot(definition, reader({ remoteGeneration: async () => "other-generation" })), /身份/);
  let reads = 0;
  await assert.rejects(resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (_id, pathname) => pathname === "/meta" ? reply(++reads === 1 ? meta : { ...meta, managerInstanceId: "changed" }) : reply({ code: 0, data: snapshot }) })), /身份/);
  let identityReads = 0;
  await assert.rejects(resolveRemotePersonaSnapshot(definition, reader({ identity: () => ++identityReads === 1 ? local : { ...local, managerInstanceId: "changed" } })), /身份/);
});
test("remote reply cannot substitute another persona or invalid config", async () => {
  for (const corrupt of [{ ...snapshot, roleId: "Other" }, { ...snapshot, personaConfig: [] }, { ...snapshot, applicationGenerationId: "wrong" }]) {
    await assert.rejects(resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (_id, pathname) => pathname === "/meta" ? reply(meta) : reply({ code: 0, data: corrupt }) })));
  }
});

test("remote consumer accepts documents and envelopes above former fixed quotas", async () => {
  const document = "x".repeat(5 * 1024 * 1024);
  const data = await resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (_id, pathname) => pathname === "/meta" ? reply(meta) : reply({ code: 0, data: { ...snapshot, document } }) }));
  assert.equal(data.document, document);
});

test("remote language style runs on its owner and rejects owner changes or inconsistent replies", async () => {
  const styleSkillUrl = "file:///owner/style/SKILL.md";
  const data = await resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (_device, pathname) => pathname === "/meta" ? reply(meta) : reply({ code: 0, data: { ...snapshot, personaConfig: { languageStyle: { styleSkillUrl } } } }) }));
  const styleResult = { passed: true, status: "passed", styleSkillUrl, scope: "outbound_message", violations: [], checkedRuleIds: ["EXAMPLE-1"], skippedRuleIds: [] };
  const calls: string[] = [];
  const context = reader({ fetchRemote: async (device, pathname, init) => {
    assert.equal(device, "peer-b"); calls.push(pathname);
    if (pathname === "/meta") return reply(meta);
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { text: "Example reply", file: snapshot.file, revision: snapshot.revision });
    return reply({ code: 0, data: styleResult });
  } });
  assert.deepEqual(await validateRemotePersonaLanguageStyle(data, "Example reply", context), styleResult);
  assert.deepEqual(calls, ["/meta", "/api/roles/Example/persona-reference/language-style", "/meta"]);
  await assert.rejects(validateRemotePersonaLanguageStyle(data, "Example reply", { ...context, remoteGeneration: async () => "changed-generation" }), /身份/);
  await assert.rejects(validateRemotePersonaLanguageStyle(data, "Example reply", reader({ fetchRemote: async (_device, pathname) => pathname === "/meta" ? reply(meta) : reply({ code: 0, data: { ...styleResult, status: "unavailable" } }) })), /无效/);
});
test("local source reads bounded persona files without rewriting configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "persona-reference-"));
  try {
    const configText = JSON.stringify({ speechTriggerKeywords: ["Example"], recentMessageLimits: { napcat: 5 } });
    await fs.writeFile(path.join(root, "persona.md"), "# Example\nUse the selected persona.");
    await fs.writeFile(path.join(root, "personaConfig.json"), configText);
    const data = await readPersonaReferenceSnapshot(root, "Example", "persona.md", remote);
    assert.equal(data.personaConfig.recentMessageLimits?.napcat, 5);
    assert.match(data.revision, /^[a-f0-9]{64}$/);
    assert.equal(await fs.readFile(path.join(root, "personaConfig.json"), "utf8"), configText);
    await assert.rejects(readPersonaReferenceSnapshot(root, "../Other", "persona.md", remote));
    await assert.rejects(readPersonaReferenceSnapshot(root, "Example", "../persona.md", remote));
    await fs.writeFile(path.join(root, "personaConfig.json"), "invalid");
    await assert.rejects(readPersonaReferenceSnapshot(root, "Example", "persona.md", remote), /有效 JSON/);
    await fs.writeFile(path.join(root, "persona.md"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await fs.writeFile(path.join(root, "personaConfig.json"), JSON.stringify({ extra: "x".repeat(300 * 1024) }));
    assert.equal((await readPersonaReferenceSnapshot(root, "Example", "persona.md", remote)).document.length, 2 * 1024 * 1024 + 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("private route request checks generation, capability and the persisted selection", async () => {
  let resolveCalls = 0;
  let denied = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    const json = (res: http.ServerResponse, status: number, data: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (!handleRemotePersonaResolutionApi(request, url, response, { identity: () => local, isLoopback: () => true,
      definition: id => id === definition.id ? definition : undefined,
      verifyCapability: (route, role, cap) => route === definition.id && role === "Example" && cap === "route-capability",
      resolve: async () => { resolveCalls++; if (denied) throw new TunnelDenied("peer_device_not_trusted"); return resolveRemotePersonaSnapshot(definition, reader()); }, json })) {
      response.writeHead(404).end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const headers = { [ROLE_CONTEXT_ROUTE_HEADER]: definition.id, [ROLE_CONTEXT_CAPABILITY_HEADER]: "route-capability", [ROLE_CONTEXT_GENERATION_HEADER]: local.applicationGenerationId, [ROLE_CONTEXT_MANAGER_HEADER]: local.managerInstanceId };
  try {
    assert.equal((await fetch(base + "/api/internal/remote-persona/resolve?routeId=route-a", { headers })).status, 200);
    assert.equal((await fetch(base + "/api/internal/remote-persona/resolve?routeId=other", { headers })).status, 403);
    assert.equal((await fetch(base + "/api/internal/remote-persona/resolve?routeId=route-a", { headers: { ...headers, [ROLE_CONTEXT_GENERATION_HEADER]: "stale" } })).status, 409);
    assert.equal((await fetch(base + "/api/internal/remote-persona/resolve?routeId=route-a&file=other.md", { headers })).status, 403);
    assert.equal(resolveCalls, 1);
    denied = true;
    const deniedResponse = await fetch(base + "/api/internal/remote-persona/resolve?routeId=route-a", { headers });
    assert.equal(deniedResponse.status, 403);
    assert.equal((await deniedResponse.json() as { error: string }).error, "REMOTE_PERSONA_ACCESS_DENIED");
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

const jsonResponse = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data));
};
async function listening(server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}

test("persona bootstrap requires the authenticated control entry and fences the local generation", async () => {
  let allowed = true;
  let current = local;
  let mode = "success";
  const calls: string[] = [];
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("peer", [createPersonaBootstrapOperation({
    allowed: () => allowed, identity: () => current,
    ensure: async deviceId => {
      calls.push(deviceId);
      if (mode === "upgrade") throw new Error("peer_persona_upgrade_required");
      if (mode === "denied") throw new TunnelDenied("peer_identity_changed");
      if (mode === "offline") throw new Error("peer_device_offline");
      if (mode === "changed") current = { ...local, managerInstanceId: "changed" };
      if (mode === "revoked") allowed = false;
    }
  })]);
  const server = http.createServer((request, response) => { if (!registry.handle(request, new URL(request.url || "/", "http://localhost"), response)) response.writeHead(404).end(); });
  const base = await listening(server);
  const post = (body: unknown) => fetch(base + "/api/rabilink/peer/persona/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    allowed = false;
    assert.equal((await post({ deviceId: "peer-b" })).status, 403);
    assert.deepEqual(calls, []);
    allowed = true;
    for (const body of [null, { deviceId: "../peer-b" }, { deviceId: "peer-b", services: ["manager"] }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(await (await post({ deviceId: "peer-b" })).json(), { code: 0, data: { deviceId: "peer-b" } });
    for (const [failureMode, expected] of [["upgrade", 426], ["denied", 403], ["offline", 503], ["changed", 409], ["revoked", 403]] as const) {
      mode = failureMode;
      current = local;
      allowed = true;
      assert.equal((await post({ deviceId: "peer-b" })).status, expected);
    }
  } finally { await registration.dispose(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("source style validation uses only the selected persona binding and current revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "persona-owned-style-"));
  const styleSkillUrl = "file:///owner/style/SKILL.md";
  let current = remote;
  let validations = 0;
  let change = "";
  await fs.writeFile(path.join(root, "persona.md"), "# Example");
  await fs.writeFile(path.join(root, "personaConfig.json"), JSON.stringify({ languageStyle: { styleSkillUrl } }));
  const initial = await readPersonaReferenceSnapshot(root, "Example", "persona.md", remote);
  const result = { passed: true, status: "passed" as const, styleSkillUrl, scope: "outbound_message", violations: [], checkedRuleIds: [], skippedRuleIds: [] };
  const routes = new ManagerPluginRouteRegistry();
  const registration = routes.registerOperations("fixture-persona-resources", createPersonaResourceOperations({ rolesRoot: path.dirname(root),
    roleDirectory: roleId => { assert.equal(roleId, "Example"); return root; }, identity: () => current,
    validate: async input => {
      validations++;
      assert.deepEqual(input, { text: "Example reply", styleSkillUrl, scope: "outbound_message" });
      if (change === "identity") current = { ...remote, managerInstanceId: "changed" };
      if (change === "config") await fs.writeFile(path.join(root, "personaConfig.json"), "{}");
      return result;
    }
  }));
  const server = http.createServer((request, response) => { if (!routes.handle(request, new URL(request.url || "/", "http://localhost"), response)) response.writeHead(404).end("{}"); });
  const base = await listening(server);
  const body = { text: "Example reply", file: "persona.md", revision: initial.revision };
  const post = (value: unknown) => fetch(base + "/api/roles/Example/persona-reference/language-style", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  try {
    assert.deepEqual(await (await post(body)).json(), { code: 0, data: result });
    assert.equal((await post({ ...body, styleSkillUrl: "file:///caller/arbitrary.json" })).status, 400);
    assert.equal((await post({ ...body, file: "../persona.md" })).status, 400);
    assert.equal((await post({ ...body, revision: "0".repeat(64) })).status, 409);
    assert.equal(validations, 1);
    change = "identity";
    assert.equal((await post(body)).status, 409);
    current = remote;
    change = "config";
    assert.equal((await post(body)).status, 409);
  } finally {
    await registration.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("owner-local absolute style paths stay on the owner and preserve their configured reference", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "persona-absolute-style-"));
  const styleDir = path.join(root, "style");
  const styleSkillUrl = path.join(styleDir, "SKILL.md");
  await fs.mkdir(path.join(styleDir, "references"), { recursive: true });
  await fs.writeFile(styleSkillUrl, "# Owner style");
  await fs.writeFile(path.join(styleDir, "references", "style-data.json"), JSON.stringify({ runtimeConstraints: { checks: [] } }));
  await fs.writeFile(path.join(root, "persona.md"), "# Example");
  await fs.writeFile(path.join(root, "personaConfig.json"), JSON.stringify({ languageStyle: { styleSkillUrl } }));
  const source = await readPersonaReferenceSnapshot(root, "Example", "persona.md", remote);
  const validator = new LanguageStyleValidator();
  const routes = new ManagerPluginRouteRegistry();
  const registration = routes.registerOperations("fixture-persona-resources", createPersonaResourceOperations({ rolesRoot: path.dirname(root),
    roleDirectory: () => root, identity: () => remote, validate: input => validator.validate(input)
  }));
  const server = http.createServer((request, response) => { if (!routes.handle(request, new URL(request.url || "/", "http://localhost"), response)) response.writeHead(404).end("{}"); });
  const base = await listening(server);
  try {
    const data = await resolveRemotePersonaSnapshot(definition, reader({ fetchRemote: async (_id, pathname) =>
      pathname === "/meta" ? reply(meta) : reply({ code: 0, data: source }) }));
    const result = await validateRemotePersonaLanguageStyle(data, "Example reply", reader({ fetchRemote: async (_id, pathname, init) =>
      pathname === "/meta" ? reply(meta) : fetch(base + pathname, init) }));
    assert.equal(result.passed, true);
    assert.equal(result.styleSkillUrl, styleSkillUrl);
    assert.match(result.styleDataUrl || "", /^file:/);
  } finally {
    await registration.dispose();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("persona quotas are optional and explicit document/config/response quotas identify their setting", () => {
  assert.deepEqual(readPersonaReadSettings({}), { documentBytes: 0, configBytes: 0, responseBytes: 0 });
  assert.throws(() => readPersonaReadSettings({ RABIROUTE_PERSONA_CONFIG_MAX_BYTES: "-1" }), /RABIROUTE_PERSONA_CONFIG_MAX_BYTES/);
  const program = [
    "import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';",
    "import {readPersonaReferenceSnapshot,resolveRemotePersonaSnapshot} from './src/manager/remotePersonaRoutes.ts';",
    "const setting=process.env.TEST_SETTING;const root=await fs.mkdtemp(path.join(os.tmpdir(),'persona-quota-'));",
    "try{await fs.writeFile(path.join(root,'persona.md'),'document');await fs.writeFile(path.join(root,'personaConfig.json'),'{}');",
    "const identity={applicationGenerationId:'generation',managerInstanceId:'instance'};",
    "const result=setting.endsWith('RESPONSE_MAX_BYTES')?resolveRemotePersonaSnapshot({agentRoleDeviceId:'peer',agentRoleId:'Example'},{identity:()=>identity,managerBaseUrl:'http://localhost',remoteGeneration:async()=>identity.applicationGenerationId,fetchRemote:async()=>Response.json({data:'response'})}):readPersonaReferenceSnapshot(root,'Example','persona.md',identity);",
    "await assert.rejects(result,error=>{assert.equal(error.code,'PERSONA_FILE_TOO_LARGE');assert.match(error.message,new RegExp(setting+'=1'));return true;});",
    "}finally{await fs.rm(root,{recursive:true,force:true});}"
  ].join('\n');
  for (const setting of ["RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES", "RABIROUTE_PERSONA_CONFIG_MAX_BYTES", "RABIROUTE_PERSONA_RESPONSE_MAX_BYTES"]) {
    const result = spawnSync(process.execPath, ["--import", "./scripts/test-manager-runtime-env.mjs", "--import", "tsx", "--input-type=module", "--eval", program], {
      cwd: process.cwd(), env: { ...process.env, TEST_SETTING: setting, [setting]: "1" }, windowsHide: true, encoding: "utf8", timeout: 20000
    });
    assert.equal(result.status, 0, result.stderr);
  }
});
