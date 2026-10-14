import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext, type AgentServiceSourcePrincipal } from "./agentEndpointDelivery.js";
import { AgentRequestStore } from "../agentRequests/store.js";
import type { AgentThreadRequest } from "../agentThreads.js";
import type { AgentRequestEndpoint } from "../agentRequests/endpoint.js";

test("factory accepts a source without cwd, freezes trusted device identity and confines cwd requirements to host targets", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "endpoint-factory-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let authorized = true;
  const deviceRoles: string[] = [];
  const device: AgentRequestEndpoint = { kind: "device", managerInstanceId: "manager", instanceId: "pc-owner", agentId: "glasses", provider: "deviceAgent", sessionId: "device-session", authorizationIncarnation: "epoch" };
  const deviceParty = { endpoint: device, threadId: device.sessionId, agentAdapter: "deviceAgent" as const, agentType: "agent" };
  const context = {
    store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {}, receiptDirectory: directory,
    readLocal: async (_provider: unknown, id: string) => ({ id, title: "Exact task", updatedAt: "", archived: false }),
    localOptions: () => ({ allowedWorkspaces: [] }),
    device: {
      resolveSource: async (request: AgentThreadRequest, principal?: { sourceDeviceId: string }) => {
        if (request.messageSource?.type !== "agent" || request.messageSource.agentAdapter !== "deviceAgent") return undefined;
        assert.equal(principal?.sourceDeviceId, "binding-original"); return deviceParty;
      },
      resolveTarget: async (request: AgentThreadRequest) => request.agentAdapter === "deviceAgent" ? deviceParty : undefined,
      authorize: (_endpoint: AgentRequestEndpoint, role?: "source" | "target") => { deviceRoles.push(role || "missing"); if (!authorized) throw new Error("revoked"); }, transport: async () => undefined
    }
  } as unknown as AgentEndpointDeliveryContext;
  const factory = createAgentEndpointDelivery(context);
  const source: AgentThreadRequest = { action: "send", sourceThreadId: "source", sourceAgentType: "agent", agentAdapter: "deviceAgent", threadId: device.sessionId,
    messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source", sessionName: "Source" } };
  const options = factory.options();
  assert.equal((await options.resolveSource(source)).workspace, undefined);
  const target = await options.resolveTarget(source);
  assert.deepEqual(options.resolveExecutionOptions(source, target), {});
  await assert.rejects(async () => options.resolveTarget({ ...source, agentAdapter: "codex", threadId: "host-task" }), /existing absolute/);
  assert.throws(() => factory.options(undefined, undefined, { scope: "app", sourceDeviceId: "binding-original", deviceOwner: true }), /HTTP admission/);
  const principal = { scope: "app", sourceDeviceId: "binding-original", deviceOwner: true };
  const fromDevice = factory.options(undefined, () => { if (!authorized) throw new Error("revoked"); }, principal);
  principal.sourceDeviceId = "binding-replacement";
  assert.equal((await fromDevice.resolveSource({ ...source, sourceThreadId: device.sessionId,
    messageSource: { type: "agent", agentAdapter: "deviceAgent", sessionId: device.sessionId, sessionName: "Glasses" } })).endpoint?.kind, "device");
  await assert.rejects(async () => fromDevice.resolveSource(source), /source substitution is forbidden/);
  await factory.refreshEndpoints({ source: device, target: device });
  assert.deepEqual(deviceRoles.slice(-3), ["source", "target", "source"]);
  authorized = false;
  assert.throws(() => fromDevice.authorize(device), /revoked/);
});

test("factory rejects missing source, unsupported system ownership and invalid source roles with explicit repair fields", async () => {
  let reads = 0;
  const context = { store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {}, receiptDirectory: "unused-memory-receipts",
    readLocal: async (_provider: unknown, id: string) => { reads++; return { id, title: "Source", updatedAt: "", archived: false }; },
    localOptions: () => ({ allowedWorkspaces: [] }) } as unknown as AgentEndpointDeliveryContext;
  const options = createAgentEndpointDelivery(context).options();
  const system = { type: "system" as const, eventType: "test", eventName: "Test", eventId: "event" };
  await assert.rejects(async () => options.resolveSource({ sourceAgentType: "agent", messageSource: system }),
    { field: "sourceThreadId", stage: "source_verification" });
  await assert.rejects(async () => options.resolveSource({ sourceThreadId: "source", sourceAgentType: "agent", messageSource: system }),
    error => { assert.equal((error as { field: string }).field, "messageSource"); assert.match((error as { repair: string }).repair, /system/); return true; });
  await assert.rejects(async () => options.resolveSource({ sourceThreadId: "source", sourceAgentType: "system" as "agent",
    messageSource: { type: "agent", agentAdapter: "codex", sessionId: "source", sessionName: "Source" } }), { field: "sourceAgentType" });
  assert.equal(reads, 0);
});

test("registered service bridge preserves its authenticated owner and delivers without PC directory requirements", async () => {
  const endpoint: AgentRequestEndpoint = { kind: "local", managerInstanceId: "manager", agentId: "cloud-owner", provider: "astrbot",
    sessionId: "cloud-session", authorizationIncarnation: "cloud-epoch" };
  const party = { endpoint, agentAdapter: "astrbot" as const, agentType: "agent", threadId: endpoint.sessionId, threadName: "Cloud task" };
  const roles: string[] = [];
  let transports = 0;
  const context = { store: new AgentRequestStore({ read: () => undefined, write: () => {} }),
    registry: { localInstanceId: "manager", listInstances: () => [] }, authority: {}, config: {}, receiptDirectory: "unused-service-receipts",
    readLocal: async () => { throw new Error("service must not read a Desktop owner"); }, localOptions: () => ({ allowedWorkspaces: [] }),
    service: { owns: (value: AgentRequestEndpoint) => value.provider === "astrbot" && value.agentId === endpoint.agentId,
      resolveSource: async (_request: AgentThreadRequest, principal?: AgentServiceSourcePrincipal) => {
        assert.equal(principal?.agentId, "cloud-owner"); return party;
      }, resolveTarget: async () => party,
      authorize: (_value: AgentRequestEndpoint, role?: string) => { roles.push(role || "missing"); },
      refresh: async () => {}, resolveExecutionOptions: () => ({}), transport: async () => { transports++; return undefined; } }
  } as unknown as AgentEndpointDeliveryContext;
  const factory = createAgentEndpointDelivery(context);
  const principal = { provider: "astrbot" as const, agentId: endpoint.agentId, sessionId: endpoint.sessionId, authorizationIncarnation: endpoint.authorizationIncarnation };
  assert.throws(() => factory.options(undefined, undefined, undefined, principal), /HTTP admission/);
  const callerExecutionOptions = { model: "original-explicit-model" };
  const options = factory.options(undefined, () => {}, undefined, principal, callerExecutionOptions);
  principal.agentId = "replacement";
  callerExecutionOptions.model = "replacement";
  assert.equal(options.callerExecutionOptions?.model, "original-explicit-model");
  assert.equal(Object.isFrozen(options.callerExecutionOptions), true);
  const request: AgentThreadRequest = { sourceThreadId: endpoint.sessionId, sourceAgentType: "agent", threadId: endpoint.sessionId,
    agentAdapter: "astrbot", messageSource: { type: "agent", agentAdapter: "astrbot", sessionName: "Cloud task", sessionId: endpoint.sessionId } };
  assert.equal((await options.resolveSource(request)).workspace, undefined);
  const target = await options.resolveTarget(request);
  assert.deepEqual(options.resolveExecutionOptions(request, target), {});
  await factory.refreshEndpoints({ source: endpoint, target: endpoint });
  assert.deepEqual(roles, ["source", "target", "source"]);
  await options.dispatch({ target: endpoint } as Parameters<typeof options.dispatch>[0], () => {}).catch(error => assert.match(error.message, /No exact owner receipt/));
  assert.equal(transports, 1);
});
