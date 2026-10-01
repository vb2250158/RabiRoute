import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RouteProfile } from "../config.js";
import { resolvePipeline } from "../pipelines.js";
import { buildAgentPacket } from "./agentPacket.js";
import {
  fetchRemotePersonaSnapshot,
  RemotePersonaUnavailableError,
  routeWithRemotePersonaConfig,
  type RemotePersonaSnapshot
} from "./remotePersonaClient.js";

const request = {
  managerBaseUrl: "http://127.0.0.1:61234", routeId: "local-route", capability: "capability",
  applicationGenerationId: "generation-a", managerInstanceId: "manager-a",
  deviceId: "pc-b", roleId: "SharedPersona", file: "persona.md"
};
function snapshot(patch: Partial<RemotePersonaSnapshot> = {}): RemotePersonaSnapshot {
  return {
    schemaVersion: 1, deviceId: request.deviceId, roleId: request.roleId, file: request.file,
    document: "# 远端人格\n只采用远端人格的明确设定。",
    revision: "a".repeat(64),
    personaConfig: { notificationRules: [{ id: "remote-rule", routeKinds: ["private"], regex: "remote", template: "远端消息模板" }] },
    applicationGenerationId: request.applicationGenerationId, managerInstanceId: request.managerInstanceId,
    remoteApplicationGenerationId: "generation-b", remoteManagerInstanceId: "manager-b",
    knowledgeApiBaseUrl: `${request.managerBaseUrl}/api/rabilink/peer/http/pc-b/persona`,
    ...patch
  };
}
function route(directory: string): RouteProfile {
  return {
    id: request.routeId, name: "Local route", enabled: true, agentRoleId: request.roleId,
    agentRoleDeviceId: request.deviceId, agentRoleFile: "persona.md", rolesDir: path.join(directory, "roles"),
    dataDir: path.join(directory, "route"), recentMessageLimit: 12, resolvedPipeline: resolvePipeline("agent"),
    routeVariables: {}, notificationRules: [{ id: "stale-local-rule", name: "stale", enabled: true, routeKinds: ["private"], template: "stale" }]
  };
}

test("remote persona fetch is Route-fenced and does not let the caller choose remote query targets", async () => {
  let capturedUrl = "";
  let capturedHeaders = new Headers();
  const actual = await fetchRemotePersonaSnapshot({ ...request, fetchImpl: async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = new Headers(init?.headers);
    return Response.json({ code: 0, data: snapshot() });
  } });
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/api/internal/remote-persona/resolve");
  assert.deepEqual([...url.searchParams], [["routeId", request.routeId], ["file", request.file]]);
  assert.equal(capturedHeaders.get("x-rabiroute-route-id"), request.routeId);
  assert.equal(capturedHeaders.get("x-rabiroute-persona-messaging-capability"), request.capability);
  assert.equal(capturedHeaders.get("x-rabiroute-expected-application-generation-id"), request.applicationGenerationId);
  assert.equal(capturedHeaders.get("x-rabiroute-expected-manager-instance-id"), request.managerInstanceId);
  assert.equal(actual.document, snapshot().document);
});

test("remote persona identity changes, denied access and unavailable target fail closed", async () => {
  for (const patch of [
    { deviceId: "another-pc" }, { roleId: "another-role" }, { file: "other.md" },
    { applicationGenerationId: "generation-next" }, { managerInstanceId: "manager-next" },
    { remoteApplicationGenerationId: "" }, { remoteManagerInstanceId: "" },
    { knowledgeApiBaseUrl: "http://127.0.0.1:60000/api/roles" },
    { knowledgeApiBaseUrl: `${request.managerBaseUrl}/api/rabilink/peer/http/pc-b/manager` },
    { revision: "" }, { revision: "short-revision" }, { revision: "A".repeat(64) }
  ]) {
    await assert.rejects(fetchRemotePersonaSnapshot({ ...request, fetchImpl: async () => Response.json({ code: 0, data: snapshot(patch) }) }),
      (error: unknown) => error instanceof RemotePersonaUnavailableError && error.code === "REMOTE_PERSONA_IDENTITY_MISMATCH");
  }
  for (const status of [403, 503]) {
    await assert.rejects(fetchRemotePersonaSnapshot({ ...request, fetchImpl: async () => Response.json({ code: -1, error: "peer_denied" }, { status }) }),
      (error: unknown) => error instanceof RemotePersonaUnavailableError && error.statusCode === status);
  }
  await assert.rejects(fetchRemotePersonaSnapshot({ ...request, fetchImpl: async () => { throw new Error("offline"); } }), /offline/);
});

test("remote persona resolution observes cancellation and requires a complete owning identity", async () => {
  await assert.rejects(fetchRemotePersonaSnapshot({ ...request, capability: "", fetchImpl: async () => { throw new Error("must not request"); } }),
    (error: unknown) => error instanceof RemotePersonaUnavailableError && error.code === "REMOTE_PERSONA_IDENTITY_REQUIRED");
  await assert.rejects(fetchRemotePersonaSnapshot({ ...request, timeoutMs: 5, fetchImpl: async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  } }), /timed out/);
});

test("remote rules replace stale local rules without carrying remote scripts or schedules", () => {
  const original = route("fixture");
  const remote = snapshot({ personaConfig: {
    recentMessageLimits: { napcat: 7 },
    automationRules: [
      { id: "remote-message", trigger: { type: "message", routeKinds: ["private"], regex: "remote" }, action: { type: "deliver_agent", template: "remote template" } },
      { id: "remote-script", trigger: { type: "message", routeKinds: ["private"] }, action: { type: "run_script", scriptPath: "danger.ps1" } },
      { id: "remote-schedule", trigger: { type: "schedule", schedule: { id: "remote-tick", type: "interval", intervalSeconds: 600 } }, action: { type: "deliver_agent", message: "schedule" } }
    ]
  } });
  const actual = routeWithRemotePersonaConfig(original, remote);
  assert.equal(actual.notificationRules.find(rule => rule.id === "remote-message")?.template, "remote template");
  assert.equal(actual.notificationRules.some(rule => rule.id === "stale-local-rule"), false);
  assert.equal(actual.automationRules?.some(rule => rule.action.type === "run_script" || rule.trigger.type === "schedule"), false);
  assert.equal(actual.personaAutomationScriptsEnabled, false);
  assert.equal(actual.recentMessageLimits?.napcat, 7);
  assert.equal(original.notificationRules[0].id, "stale-local-rule");
});

test("remote AgentPacket uses inline remote persona and remote knowledge, never a same-named local role", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-remote-packet-"));
  const previousManager = process.env.GATEWAY_MANAGER_URL;
  process.env.GATEWAY_MANAGER_URL = request.managerBaseUrl;
  try {
    const original = route(directory);
    const remote = snapshot();
    const effective = routeWithRemotePersonaConfig(original, remote);
    const rule = effective.notificationRules.find(item => item.id === "remote-rule")!;
    const localRoleDir = path.join(original.rolesDir, request.roleId);
    fs.mkdirSync(localRoleDir, { recursive: true });
    const poison = path.join(localRoleDir, "persona.md");
    fs.writeFileSync(poison, "# WRONG LOCAL PERSONA\nMust never appear.");
    const before = fs.readdirSync(localRoleDir);
    const record = { time: 1, rawMessage: "remote hello", messageId: "message-remote", userId: 42, senderName: "User" };
    const packet = buildAgentPacket({ route: effective, routeKind: "private", record, extraValues: {}, matchedRules: [rule], routeVariables: {}, routeText: record.rawMessage }, rule,
      { roleId: request.roleId, roleDir: localRoleDir, rolePath: poison, routeDataDir: original.dataDir!, personaDataDir: localRoleDir },
      { remotePersona: remote });
    assert.match(packet.content, /远端人格正文/);
    assert.match(packet.content, /只采用远端人格的明确设定/);
    assert.ok(packet.content.includes(`${remote.knowledgeApiBaseUrl}/api/roles/${request.roleId}/knowledge/search`));
    assert.match(packet.content, /此远端人格入口只读/);
    assert.doesNotMatch(packet.content, /\/peer\/http\/pc-b\/manager/);
    assert.doesNotMatch(packet.content, /WRONG LOCAL PERSONA|请遵循角色文件|角色目录：|计划目录：|记忆目录：|无人格直通模式/);
    assert.equal(packet.templateValues.agentRolePath, undefined);
    assert.equal(packet.templateValues.agentRoleDir, undefined);
    assert.deepEqual(fs.readdirSync(localRoleDir), before);
    assert.equal(fs.readFileSync(poison, "utf8"), "# WRONG LOCAL PERSONA\nMust never appear.");
  } finally {
    if (previousManager === undefined) delete process.env.GATEWAY_MANAGER_URL;
    else process.env.GATEWAY_MANAGER_URL = previousManager;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
