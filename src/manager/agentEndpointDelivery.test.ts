import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentEndpointDelivery, type AgentEndpointDeliveryContext } from "./agentEndpointDelivery.js";
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
