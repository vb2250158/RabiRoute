import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config, type RouteProfile } from "./config.js";
import { forwardMessageAndWait, resetMessageProcessingRuntime } from "./forwarding.js";
import { resolvePipeline } from "./pipelines.js";
import type { RemotePersonaSnapshot } from "./routing/remotePersonaClient.js";

const identityKeys = ["GATEWAY_MANAGER_URL", "GATEWAY_ID", "PERSONA_MESSAGING_CAPABILITY", "RABIROUTE_APPLICATION_GENERATION_ID", "RABIROUTE_MANAGER_INSTANCE_ID"] as const;

async function withRemoteRoute(
  responseFor: (snapshot: RemotePersonaSnapshot) => { status: number; payload: unknown },
  run: (route: RouteProfile, requests: string[]) => Promise<void>
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabi-remote-forward-"));
  const requests: string[] = [];
  let baseUrl = "";
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const snapshot: RemotePersonaSnapshot = {
      schemaVersion: 1, deviceId: "pc-b", roleId: "Shared", file: "persona.md", document: "# Remote authoritative persona",
      revision: "a".repeat(64),
      personaConfig: { notificationRules: [{ id: "remote-private", routeKinds: ["private"], regex: "remote", template: "Remote template {message}" }] },
      applicationGenerationId: "generation-a", managerInstanceId: "manager-a", remoteApplicationGenerationId: "generation-b", remoteManagerInstanceId: "manager-b",
      knowledgeApiBaseUrl: `${baseUrl}/api/rabilink/peer/http/pc-b/persona`
    };
    const result = responseFor(snapshot);
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.payload));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const previousEnvironment = Object.fromEntries(identityKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    GATEWAY_MANAGER_URL: baseUrl, GATEWAY_ID: "local-route", PERSONA_MESSAGING_CAPABILITY: "route-capability",
    RABIROUTE_APPLICATION_GENERATION_ID: "generation-a", RABIROUTE_MANAGER_INSTANCE_ID: "manager-a"
  });
  const previousConfig = {
    routeProfiles: config.routeProfiles, dataDir: config.dataDir, memoryDataDir: config.memoryDataDir,
    agentAdapters: config.agentAdapters, primaryAgentTarget: config.primaryAgentTarget,
    primaryAgentAdapter: config.primaryAgentAdapter, remoteAgentTargets: config.remoteAgentTargets,
    messageProcessingAgents: config.messageProcessingAgents
  };
  const route: RouteProfile = {
    id: "local-route", name: "Local route", enabled: true, agentRoleDeviceId: "pc-b", agentRoleId: "Shared", agentRoleFile: "persona.md",
    rolesDir: path.join(directory, "roles"), dataDir: path.join(directory, "route"), recentMessageLimit: 0,
    resolvedPipeline: resolvePipeline("agent"), routeVariables: {},
    notificationRules: [{ id: "stale-group-only", name: "stale", enabled: true, routeKinds: ["group_message"], template: "Wrong local template" }],
    personaAutomationScriptsEnabled: true,
    automationRules: [{ id: "stale-script", enabled: true, trigger: { type: "message", routeKinds: ["private"] }, action: { type: "run_script", scriptPath: "stale.ps1" } }]
  };
  Object.assign(config, {
    routeProfiles: [route], dataDir: route.dataDir!, memoryDataDir: path.join(directory, "gateway-memory"),
    agentAdapters: [], primaryAgentTarget: "", primaryAgentAdapter: undefined, remoteAgentTargets: [], messageProcessingAgents: {}
  });
  try {
    await run(route, requests);
    assert.deepEqual(requests.map(value => value.split(" ")[0]), requests.map(() => "GET"));
    assert.ok(requests.every(value => value.startsWith("GET /api/internal/remote-persona/resolve?routeId=local-route&file=persona.md")));
  } finally {
    resetMessageProcessingRuntime();
    Object.assign(config, previousConfig);
    for (const key of identityKeys) {
      const previous = previousEnvironment[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const message = { time: 1, rawMessage: "remote hello", messageId: "remote-message", userId: 42, senderName: "User" };

test("forwarding resolves remote rules before matching and keeps all local audit data in the Route", async () => {
  await withRemoteRoute(snapshot => ({ status: 200, payload: { code: 0, data: snapshot } }), async (route, requests) => {
    const result = await forwardMessageAndWait("private", message, {}, { logReplayAttempt: false });
    assert.equal(result.status, "routed");
    assert.deepEqual(result.matchedRuleIds, ["remote-private"]);
    assert.equal(result.sentPacketCount, 1);
    assert.equal(requests.length, 1);
    assert.equal(fs.existsSync(path.join(route.rolesDir, "Shared")), false);
    assert.equal(fs.existsSync(path.join(route.dataDir!, "private-messages.jsonl")), true);
    const packetLog = fs.readFileSync(path.join(route.dataDir!, "agent-packets.jsonl"), "utf8");
    assert.match(packetLog, /Remote authoritative persona/);
    assert.match(packetLog, /Remote template remote hello/);
    assert.doesNotMatch(packetLog, /Wrong local template|请遵循角色文件/);
    assert.equal(route.notificationRules[0].id, "stale-group-only");
    const automationLog = path.join(route.dataDir!, "automation-executions.jsonl");
    assert.equal(fs.existsSync(automationLog), false);
  });
});

test("denied and identity-changing remote responses stop delivery without touching a same-named local persona", async () => {
  for (const responseFor of [
    () => ({ status: 403, payload: { code: -1, error: "peer_device_not_trusted" } }),
    (snapshot: RemotePersonaSnapshot) => ({ status: 200, payload: { code: 0, data: { ...snapshot, applicationGenerationId: "changed-generation" } } })
  ]) {
    await withRemoteRoute(responseFor, async (route, requests) => {
      const localRole = path.join(route.rolesDir, "Shared");
      fs.mkdirSync(localRole, { recursive: true });
      fs.writeFileSync(path.join(localRole, "persona.md"), "# Poison local persona");
      const before = fs.readdirSync(localRole);
      const result = await forwardMessageAndWait("private", message, {}, { logReplayAttempt: false });
      assert.equal(result.status, "failed");
      assert.equal(result.reason, "remote_persona_unavailable");
      assert.equal(result.routes[0].status, "failed");
      assert.equal(result.sentPacketCount, 0);
      assert.deepEqual(result.adapterOutcomes, []);
      assert.deepEqual(fs.readdirSync(localRole), before);
      assert.equal(requests.length, 1);
      const diagnostic = fs.readFileSync(path.join(route.dataDir!, "router-adapter.log.jsonl"), "utf8");
      assert.match(diagnostic, /remote_persona_resolve_failed/);
      assert.equal(fs.existsSync(path.join(route.dataDir!, "agent-packets.jsonl")), false);
    });
  }
});

test("remote persona memory automation remains with the remote PC", async () => {
  await withRemoteRoute(snapshot => ({ status: 200, payload: { code: 0, data: snapshot } }), async () => {
    const result = await forwardMessageAndWait("manual_trigger", {
      time: 1, rawMessage: "consolidate", messageId: "remote-auto", triggerId: "memory-consolidation", triggerSource: "auto"
    }, {}, { logReplayAttempt: false });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "remote_persona_automation_remote_only");
    assert.equal(result.sentPacketCount, 0);
  });
});
